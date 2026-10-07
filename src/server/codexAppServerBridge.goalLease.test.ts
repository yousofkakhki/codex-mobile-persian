// @ts-nocheck
// The VM exercises the real private class with synthetic child I/O; no Codex process/config is used.
import { createRequire as moduleCreateRequire } from 'node:module';
const require = moduleCreateRequire(import.meta.url);
// Read-only extraction of the original class; all child I/O and config are synthetic.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
import { test, expect, vi, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { createCodexBridgeMiddleware } from './codexAppServerBridge';
import { appendGoalBudgetAuditRecord } from './goalBudgetAudit';
vi.mock('./goalBudgetAudit', async()=>({...await vi.importActual('./goalBudgetAudit'),appendGoalBudgetAuditRecord:vi.fn(async()=>{})}));
afterEach(()=>vi.unstubAllGlobals());
const repo = process.cwd();
const sourcePath = path.join(repo, 'src/server/codexAppServerBridge.ts');
const ts = createRequire(path.join(repo, 'package.json'))('typescript');
const source = fs.readFileSync(sourcePath, 'utf8');
function extract(sourceText) {
  const begin = sourceText.indexOf('class AppServerProcess {');
  const end = sourceText.indexOf('\nexport class BackendQueueProcessor', begin);
  assert.ok(begin >= 0 && end > begin);
  return sourceText.slice(begin, end);
}
const originalClass = extract(source);
console.log(JSON.stringify({ sourcePath, sha256: createHash('sha256').update(originalClass).digest('hex'), noLiveChildSpawned: true }));
const harnessClass = originalClass;
const js = ts.transpileModule(harnessClass + '\nglobalThis.ExtractedAppServerProcess = AppServerProcess;\n', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
function fixture(options = {}) {
  let revision = 0;
  const children = [];
  const timers = [];
  function fakeSpawn() {
    const child = new EventEmitter();
    child.label = `fixture-child-${children.length + 1}`;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.writes = [];
    child.stdin = { write: (line) => { const request = JSON.parse(line); child.writes.push(request); if (!options.verifySQLiteHome && request.method === 'config/read' && request.params?.includeLayers === false) queueMicrotask(() => reply(child,request,{config:{sqlite_home:revision ? '/replacement-sqlite-home':'/fixture-sqlite-home'}})); return true; }, end: () => {} };
    child.kill = () => { child.killed = true; return true; };
    child.killed = false;
    children.push(child);
    return child;
  }
  const context = vm.createContext({
    spawn: fakeSpawn,
    appendGoalBudgetAuditRecord,
    queueMicrotask,
    resolve: path.resolve,
    THREAD_RESPONSE_TURN_LIMIT: 10,
    STREAM_EVENT_BUFFER_LIMIT: 200,
    assertThreadProjectionIntegrity: async (...args) => { options.checks?.push(args); if (options.integrityFailure) throw new Error(options.integrityFailure); await options.integrityGate?.(); },
    asRecord: (value) => value && typeof value === "object" ? value : null,
    readNonEmptyString: (value) => typeof value === "string" ? value.trim() : "",
    buildAppServerArgs: () => ['app-server', '-c', `fixture_revision=${revision}`],
    getProviderCompatibilityConfigArgs: () => [],
    getCodexHomeDir: () => '/fixture-never-accessed',
    resolveSQLiteHome: () => revision ? '/replacement-sqlite-home' : '/fixture-sqlite-home',
    FREE_MODE_STATE_FILE: 'fixture-state-never-read.json',
    ensureDefaultFreeModeStateForMissingAuthSync: () => null,
    getSpawnInvocation: (command, args) => ({ command, args }),
    resolveCodexCommand: () => 'fake-no-executable-spawned',
    join: path.join,
    process: { env: {} },
    setTimeout: (callback, ms) => { const timer = { callback, ms, active: true, unref: () => {} }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.active = false; },
  });
  vm.runInContext(js, context);
  const app = new context.ExtractedAppServerProcess();
  if (!options.verifySQLiteHome) app.confirmedSQLiteHome = '/fixture-sqlite-home';
  return { app, children, timers, changeConfig: () => { revision += 1; } };
}
function track(promise) {
  const state = { status: 'pending' };
  promise.then((value) => { state.status = 'fulfilled'; state.value = value; }, (error) => { state.status = 'rejected'; state.error = error.message; });
  return state;
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function reply(child, request, result = {}) {
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
function initializeRequest(child) {
  const request = child.writes.find((item) => item.method === 'initialize');
  assert.ok(request, 'fixture child received initialize');
  return request;
}
async function healthyInitializedChild(f) {
  const state = track(f.app.rpc('config/read', {}));
  const child = f.children[0];
  reply(child, initializeRequest(child));
  await flush();
  const request = child.writes.find((item) => item.method === 'config/read');
  assert.ok(request);
  reply(child, request);
  await flush();
  assert.equal(state.status, 'fulfilled');
  return child;
}

async function acquire(f, child, method = 'thread/resume', id = 'owned') {
  const state = track(f.app.rpc(method, method === 'thread/start' ? {} : { threadId: id, excludeTurns: true }));
  await flush();
  reply(child, child.writes.filter(r => r.method === method).at(-1), { thread: { id }, modelProvider: 'fixture' });
  await flush(); assert.equal(state.status, 'fulfilled');
}


const goal = {threadId:'owned',objective:'Existing',status:'paused',tokenBudget:50,tokensUsed:5,timeUsedSeconds:12,createdAt:1,updatedAt:2};
function requireLease(f) { assert.equal(typeof f.app.withThreadGoalMutation,'function','exclusive Goal mutation lease must cover middleware pre/post awaits'); }
test('lease excludes raw sameGoal rpc and rpcInner throughout pre-read and post-read awaits',async()=>{
 const f=fixture(); const child=await healthyInitializedChild(f);await acquire(f,child);requireLease(f);
 let release; const gate=new Promise(r=>release=r);
 const held=track(f.app.withThreadGoalMutation('owned',async rpc=>{await rpc('thread/goal/get',{threadId:'owned'});await gate;}));await flush();
 for(const entry of ['rpc','rpcInner']){const c=track(f.app[entry]('thread/goal/clear',{threadId:'owned'}));await flush();assert.equal(c.status,'rejected');}
 assert.equal(child.writes.filter(r=>r.method==='thread/goal/clear').length,0);
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();
 const second=track(f.app.withThreadGoalMutation('owned',async()=>{}));await flush();assert.equal(second.status,'rejected');
 release();await flush();assert.equal(held.status,'fulfilled');assert.equal(f.app.goalMutationsByThreadId.size,0);
});
test('different Goal IDs acquire independent leases; sameGoal caller rejects',async()=>{
 const f=fixture(); const child=await healthyInitializedChild(f);await acquire(f,child);await acquire(f,child,'thread/resume','other');requireLease(f);
 let release;const held=track(f.app.withThreadGoalMutation('owned',async()=>await new Promise(r=>release=r)));await flush();
 const other=track(f.app.withThreadGoalMutation('other',async()=>42));await flush();assert.equal(other.status,'fulfilled');
 const same=track(f.app.withThreadGoalMutation('owned',async()=>{}));await flush();assert.equal(same.status,'rejected');release();await flush();assert.equal(held.status,'fulfilled');
});
test.each(['ownership','process','config','quarantine','error'])('lease rechecks %s after await and releases on error',async why=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);requireLease(f);
 let release;const gate=new Promise(r=>release=r);const held=track(f.app.withThreadGoalMutation('owned',async(rpc,assertAllowed)=>{await gate;if(why==='error')throw Error('fixture error');assertAllowed();}));await flush();
 if(why==='ownership')f.app.writerThreadIds.delete('owned');if(why==='process')f.app.process={...child};if(why==='config')f.changeConfig();if(why==='quarantine')f.app.timedOutRpcIds.set(99,'fixture');release();await flush();
 assert.equal(held.status,'rejected');assert.equal(f.app.goalMutationsByThreadId.size,0);assert.equal(child.killed,false);
});
test('HTTP lease prevents actual concurrent clear between existence and setter',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);requireLease(f);
 vi.stubGlobal('__codexRemoteSharedBridge__',{version:'experimental-api-v2',appServer:f.app,terminalManager:{},methodCatalog:{},telegramBridge:{},backendQueueProcessor:{}});
 const middleware=createCodexBridgeMiddleware({isOwnerAuthorized:()=>false});
 const request=Readable.from([JSON.stringify({method:'thread/goal/set',params:{threadId:'owned',objective:'Edited',status:'active'}})]);request.method='POST';request.url='/codex-api/rpc';request.headers={};
 let output='';const response=new Writable({write(c,e,d){output+=c.toString();d();}});response.setHeader=()=>{};
 const held=track(middleware(request,response,()=>{}));await new Promise(r=>setImmediate(r));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);assert.ok(get);
 const clear=track(f.app.rpcInner('thread/goal/clear',{threadId:'owned',leaseBypass:true}));await flush();assert.equal(clear.status,'rejected');
 reply(child,get,{goal});await flush();const read=child.writes.filter(r=>r.method==='thread/read').at(-1);assert.ok(read);reply(child,read,{thread:{id:'owned',status:{type:'idle'}}});await flush();
 const set=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);assert.ok(set);reply(child,set,{goal:{...goal,objective:'Edited',status:'active'}});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal:{...goal,objective:'Edited',status:'active'}});await flush();
 assert.equal(held.status,'fulfilled');assert.equal(response.statusCode,200);assert.equal(child.writes.filter(r=>r.method==='thread/goal/clear').length,0);
});
test('active editor pause with unchanged objective preserves budget/accounting',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 child.stdout.emit('data',JSON.stringify({method:'turn/started',params:{threadId:'owned',turn:{id:'active'}}})+'\n');
 const state=track(f.app.rpc('thread/goal/set',{threadId:'owned',objective:goal.objective,status:'paused',ownerConfirmed:true}));await flush();
 let get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);if(get){reply(child,get,{goal:{...goal,status:'active'}});await flush();}
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);if(read){reply(child,read,{thread:{id:'owned',status:{type:'inProgress'}}});await flush();}
 const set=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);assert.ok(set,'unchanged-objective active pause must dispatch');assert.deepEqual(JSON.parse(JSON.stringify(set.params)),{threadId:'owned',status:'paused'});
 reply(child,set,{goal:{...goal,status:'paused'}});await flush();reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal:{...goal,status:'paused'}});await flush();assert.equal(state.status,'fulfilled');
});
test.each([{objective:'Changed',status:'paused'},{tokenBudget:100,status:'paused'},{status:'active'}])('active Goal edit %j must not dispatch',async edit=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const state=track(f.app.rpc('thread/goal/set',{threadId:'owned',...edit}));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);if(get){reply(child,get,{goal:{...goal,status:'active'}});await flush();}
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);if(read){reply(child,read,{thread:{id:'owned',status:{type:'inProgress'}}});await flush();}
 assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0);
});
test('raw turn/start suspended before Goal lease cannot dispatch into outer pre-read',async()=>{
 const opts={};const f=fixture(opts);const child=await healthyInitializedChild(f);await acquire(f,child);
 let release;const gate=new Promise(r=>release=r);opts.integrityGate=()=>gate;
 const turn=track(f.app.rpc('turn/start',{threadId:'owned',input:[]}));await flush();
 delete opts.integrityGate;let end;const held=track(f.app.withThreadGoalMutation('owned',async()=>await new Promise(r=>end=r)));await flush();
 release();await flush();assert.equal(turn.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='turn/start').length,0);end();await flush();
});
test('raw direct transport cannot write Goal without matching opaque lease',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const direct=track(f.app.call('thread/goal/set',{threadId:'owned',objective:'Escape',status:'active',ownerConfirmed:true}));await flush();assert.equal(direct.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0);
});
test('middleware confirmed budget lease covers post-read and audit with no accounting reset',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 vi.stubGlobal('__codexRemoteSharedBridge__',{version:'experimental-api-v2',appServer:f.app,terminalManager:{},methodCatalog:{},telegramBridge:{},backendQueueProcessor:{}});
 const middleware=createCodexBridgeMiddleware({isOwnerAuthorized:()=>true});
 const request=Readable.from([JSON.stringify({method:'thread/goal/set',params:{threadId:'owned',status:'active',tokenBudget:100,ownerConfirmed:true}})]);request.method='POST';request.url='/codex-api/rpc';request.headers={};
 let output='';const response=new Writable({write(c,e,d){output+=c.toString();d();}});response.setHeader=()=>{};
 let auditRelease;const auditGate=new Promise(r=>auditRelease=r);const audit=await import('./goalBudgetAudit');audit.appendGoalBudgetAuditRecord.mockImplementationOnce(async()=>await auditGate);
 const held=track(middleware(request,response,()=>{}));await new Promise(r=>setImmediate(r));await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();
 const set=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);assert.ok(set);assert.ok(!Object.hasOwn(set.params,'ownerConfirmed'));reply(child,set,{goal:{...goal,status:'active',tokenBudget:100}});await flush();
 const post=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);
 const clear=track(f.app.rpcInner('thread/goal/clear',{threadId:'owned'}));await flush();assert.equal(clear.status,'rejected');
 reply(child,post,{goal:{...goal,status:'active',tokenBudget:100}});await flush();assert.equal(held.status,'pending');
 const second=track(f.app.rpc('thread/goal/set',{threadId:'owned',status:'active'}));await flush();assert.equal(second.status,'rejected');
 auditRelease();await flush();assert.equal(held.status,'fulfilled');assert.equal(response.statusCode,200);assert.equal(f.app.goalMutationsByThreadId.size,0);
});

test('POLICY raw finite owner params cannot manufacture trusted authority',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const state=track(f.app.rpc('thread/goal/set',{threadId:'owned',tokenBudget:100,status:'active',ownerConfirmed:true,ownerAuthorized:true}));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);if(get){reply(child,get,{goal});await flush();}
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);if(read){reply(child,read,{thread:{id:'owned',status:{type:'idle'}}});await flush();}
 assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0);
});
test('POLICY lease alone is not a native-write permit',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 let state;const held=track(f.app.withThreadGoalMutation('owned',async()=>{state=track(f.app.call('thread/goal/set',{threadId:'owned',status:'paused'},child,f.app.goalMutationsByThreadId.get('owned')));await flush();}));await flush();await flush();
 assert.equal(state.status,'rejected');assert.equal(held.status,'fulfilled');assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0);
});
test('POLICY scoped raw rpc cannot implicitly create without budget',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const state=track(f.app.withThreadGoalMutation('owned',rpc=>rpc('thread/goal/set',{threadId:'owned',objective:'Uncapped',status:'active'})));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);if(get){reply(child,get,{goal:null});await flush();}
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);if(read){reply(child,read,{thread:{id:'owned',status:{type:'idle'}}});await flush();}
 assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0);
});


test('POLICY concurrent scoped clear cannot race a pending setter in the same lease',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 let scoped;const held=track(f.app.withThreadGoalMutation('owned',async rpc=>{scoped=rpc;await rpc('thread/goal/set',{threadId:'owned',status:'paused'});}));await flush();
 const clear=track(scoped('thread/goal/clear',{threadId:'owned'}));await flush();
 assert.equal(clear.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='thread/goal/clear').length,0);assert.equal(f.app.goalMutationsByThreadId.size,1);
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/set').at(-1),{goal});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();
 assert.equal(held.status,'fulfilled');assert.equal(f.app.goalMutationsByThreadId.size,0);
});


test('POLICY immutable incoming intent cannot change target/objective during projection await',async()=>{
 const opts={};const f=fixture(opts);const child=await healthyInitializedChild(f);await acquire(f,child);
 let release;opts.integrityGate=()=>new Promise(r=>release=r);
 const params={threadId:'owned',objective:'Captured',status:'paused'};const state=track(f.app.rpcInner('thread/goal/set',params));await flush();
 params.threadId='foreign';params.objective='Raced';release();await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();
 const set=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);assert.ok(set);assert.deepEqual(JSON.parse(JSON.stringify(set.params)),{threadId:'owned',objective:'Captured',status:'paused'});
 reply(child,set,{goal:{...goal,objective:'Captured'}});await flush();reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal:{...goal,objective:'Captured'}});await flush();assert.equal(state.status,'fulfilled');
});
test.each([null,[],false,'bad',{threadId:''},{threadId:' owned '},{threadId:'owned',status:null},{threadId:'owned',objective:'  '},{threadId:'owned',tokensUsed:0},{threadId:'owned',status:{toString(){return 'active';}}}])('POLICY malformed/raw accounting injection %j rejects',async params=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);const state=track(f.app.rpcInner('thread/goal/set',params));await flush();assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0);assert.equal(f.app.goalMutationsByThreadId.size,0);
});
test.each(['thread/goal/set','thread/goal/clear'])('POLICY raw %s validates stored accounting before any Goal write',async method=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);const state=track(f.app.rpcInner(method,method==='thread/goal/set'?{threadId:'owned',status:'paused'}:{threadId:'owned'}));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);if(get){reply(child,get,{goal:{...goal,tokensUsed:null}});await flush();}
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);if(read){reply(child,read,{thread:{id:'owned',status:{type:'idle'}}});await flush();}
 assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method===method).length,0);assert.equal(f.app.goalMutationsByThreadId.size,0);
});
test.each(['writer','generation','deferred','quarantine'])('POLICY %s loss during authoritative pre-read blocks write',async reason=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);const state=track(f.app.rpcInner('thread/goal/set',{threadId:'owned',status:'paused'}));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);assert.ok(get);reply(child,get,{goal});
 if(reason==='writer')f.app.writerThreadIds.delete('owned');if(reason==='generation')f.app.process={...child};if(reason==='deferred')f.changeConfig();if(reason==='quarantine')f.app.timedOutRpcIds.set(123,'fixture');await flush();
 assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0);assert.equal(f.app.goalMutationsByThreadId.size,0);assert.equal(child.killed,false);
});
test('POLICY timed-out write releases lease but preserves unresolved quarantine and never retries',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);const state=track(f.app.rpcInner('thread/goal/set',{threadId:'owned',status:'paused'}));await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();
 const set=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);assert.ok(set);f.timers.filter(t=>t.active&&t.ms===120000).at(-1).callback();await flush();
 assert.equal(state.status,'rejected');assert.equal(f.app.goalMutationsByThreadId.size,0);assert.equal(f.app.timedOutRpcIds.has(set.id),true);assert.equal(child.killed,false);
 const retry=track(f.app.rpc('thread/goal/clear',{threadId:'owned'}));await flush();assert.equal(retry.status,'rejected');assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,1);assert.equal(child.writes.filter(r=>r.method==='thread/goal/clear').length,0);
});


test('POLICY callback cannot release lease before its unawaited Goal write/post-read settles',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 let setter;const outer=track(f.app.withThreadGoalMutation('owned',async rpc=>{setter=track(rpc('thread/goal/set',{threadId:'owned',status:'paused'}));return 42;}));await flush();
 assert.equal(outer.status,'pending');assert.equal(f.app.goalMutationsByThreadId.size,1);
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/set').at(-1),{goal});await flush();
 const clear=track(f.app.rpc('thread/goal/clear',{threadId:'owned'}));await flush();assert.equal(clear.status,'rejected');assert.equal(outer.status,'pending');
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();assert.equal(setter.status,'fulfilled');assert.equal(outer.status,'fulfilled');assert.equal(f.app.goalMutationsByThreadId.size,0);
});


test('POLICY clear holds lease until authoritative deletion post-read validates null',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);const state=track(f.app.rpc('thread/goal/clear',{threadId:'owned',ownerConfirmed:true}));await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();
 const clear=child.writes.filter(r=>r.method==='thread/goal/clear').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(clear.params)),{threadId:'owned'});reply(child,clear,{cleared:true});await flush();
 assert.equal(state.status,'pending');assert.equal(f.app.goalMutationsByThreadId.size,1);const post=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);assert.notEqual(post.id,child.writes.filter(r=>r.method==='thread/goal/get')[0].id);
 reply(child,post,{goal:null});await flush();assert.equal(state.status,'fulfilled');assert.equal(f.app.goalMutationsByThreadId.size,0);
});
test('POLICY mismatched no-budget post-read fails without accounting repair/retry',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);const state=track(f.app.rpc('thread/goal/set',{threadId:'owned',status:'paused'}));await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();
 reply(child,child.writes.filter(r=>r.method==='thread/goal/set').at(-1),{goal});await flush();reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal:{...goal,tokensUsed:0}});await flush();assert.equal(state.status,'rejected');assert.match(state.error,/post-write verification/);assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,1);assert.equal(f.app.goalMutationsByThreadId.size,0);assert.equal(child.killed,false);
});

test('FINAL BLOCKER raw no-budget setter after clear must not implicitly create',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const clear=track(f.app.rpc('thread/goal/clear',{threadId:'owned'}));await flush();reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal});await flush();reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();reply(child,child.writes.filter(r=>r.method==='thread/goal/clear').at(-1),{cleared:true});await flush();reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal:null});await flush();assert.equal(clear.status,'fulfilled');
 const state=track(f.app.rpcInner('thread/goal/set',{threadId:'owned',objective:'Uncapped implicit creation',status:'active'}));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);if(get){reply(child,get,{goal:null});await flush();}
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);if(read){reply(child,read,{thread:{id:'owned',status:{type:'idle'}}});await flush();}
 const set=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);if(set){reply(child,set,{goal:{...goal,objective:'Uncapped implicit creation',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0}});await flush();}
 assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0,'raw set must reject missing Goal without finite owner budget');
});
test('FINAL BLOCKER raw finite setter must validate malformed stored accounting before dispatch',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const state=track(f.app.rpcInner('thread/goal/set',{threadId:'owned',tokenBudget:100,status:'active'}));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);assert.ok(get,'raw finite request reaches authoritative accounting read before policy resolution');reply(child,get,{goal:{...goal,tokensUsed:null}});await flush();
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);if(read){reply(child,read,{thread:{id:'owned',status:{type:'idle'}}});await flush();}
 const set=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);if(set){reply(child,set,{goal:{...goal,tokenBudget:100,status:'active'}});await flush();}
 assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,0,'raw class cannot skip authoritative accounting pre-read');
});
