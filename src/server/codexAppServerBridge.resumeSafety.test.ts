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
import { test } from 'vitest';
import { applyAppServerPermissionDefaults, readAppServerPermissionIntent, readAppServerPermissionDefaults, prepareAppServerHotPermissionOverrides, mergeAppServerHotPermissionOverrides } from './appServerPermissionDefaults';
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
    applyAppServerPermissionDefaults,
    readAppServerPermissionIntent,
    readAppServerPermissionDefaults,
    prepareAppServerHotPermissionOverrides,
    mergeAppServerHotPermissionOverrides,
    queueMicrotask,
    resolve: path.resolve,
    THREAD_RESPONSE_TURN_LIMIT: 10,
    STREAM_EVENT_BUFFER_LIMIT: 200,
    assertThreadProjectionIntegrity: async (...args) => { options.checks?.push(args); if (options.integrityFailure) throw new Error(options.integrityFailure); },
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


test('REGRESSION: a projection beyond durable bytes fails closed before spawning or sending resume', async () => {
 const f=fixture({integrityFailure:'Thread history integrity mismatch: checkpoint exceeds durable rollout. Active writer preserved.'});
 const state=track(f.app.rpc('thread/resume',{threadId:'affected',excludeTurns:true,initialTurnsPage:{limit:10,sortDirection:'desc',itemsView:'full'}}));
 await flush();
 assert.equal(state.status,'rejected','unsafe resume must fail BEFORE entering the serial Rust request handler');
 assert.match(state.error,/history integrity mismatch/);
 assert.equal(f.children.length,0);
});

test('REGRESSION: hot rejoin uses bounded read-only history without resending resume or changing provider', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f);
 const params={threadId:'hot-thread',modelProvider:'openai',model:'gpt-5.4',excludeTurns:true,initialTurnsPage:{limit:10,sortDirection:'desc',itemsView:'full'}};
 const cold=track(f.app.rpc('thread/resume',params)); await flush();
 const request=child.writes.find(row=>row.method==='thread/resume');
 reply(child,request,{model:'gpt-5.4',modelProvider:'openai',thread:{id:'hot-thread',model:'gpt-5.4',modelProvider:'openai',turns:[]},initialTurnsPage:{data:[],nextCursor:null}}); await flush();
 assert.equal(cold.status,'fulfilled');
 const hot=track(f.app.rpc('thread/resume',{...params,modelProvider:'custom_endpoint',model:'fixture-model'})); await flush();
 const metadata=child.writes.filter(row=>row.method==='thread/read').at(-1);
 assert.ok(metadata,'hot resume must read live metadata instead of acquiring/rejoining the writer again');
 assert.equal(metadata.params.includeTurns,false);
 reply(child,metadata,{thread:{id:'hot-thread',model:'gpt-5.4',modelProvider:'legacy-historical-provider',status:{type:'inProgress'},turns:[]}}); await flush();
 const page=child.writes.filter(row=>row.method==='thread/turns/list').at(-1);
 assert.ok(page); assert.equal(page.params.limit,10);
 reply(child,page,{data:[],nextCursor:'older',backwardsCursor:null}); await flush();
 assert.equal(hot.status,'fulfilled'); assert.equal(hot.value.modelProvider,'openai');
 assert.equal(hot.value.model,'gpt-5.4'); assert.equal(hot.value.initialTurnsPage.nextCursor,'older');
 assert.equal(child.writes.filter(row=>row.method==='thread/resume').length,1);
 assert.equal(child.writes.filter(row=>row.method==='thread/unsubscribe').length,0,'active writer must not be unsubscribed to force provider overrides');
 f.app.dispose();
});

test('REGRESSION: a timed-out handler is not retried or killed; a late response releases quarantine', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f);
 const timed=track(f.app.rpc('thread/resume',{threadId:'stall',excludeTurns:true})); await flush();
 const req=child.writes.find(row=>row.method==='thread/resume');
 const timer=f.timers.find(timer=>timer.active && timer.ms===120000);
 timer.callback(); await flush(); assert.equal(timed.status,'rejected');
 const before=child.writes.length;
 const again=track(f.app.rpc('thread/resume',{threadId:'stall',excludeTurns:true}));
 const config=track(f.app.rpc('config/read',{})); await flush();
 assert.equal(again.status,'rejected','local timeout does not cancel the Rust handler');
 assert.equal(config.status,'rejected'); assert.equal(child.writes.length,before); assert.equal(child.killed,false);
 reply(child,req,{thread:{id:'stall'},modelProvider:'openai',model:'gpt-5.4'}); await flush();
 const recovered=track(f.app.rpc('config/read',{})); await flush();
 const cfg=child.writes.filter(row=>row.method==='config/read').at(-1);
 reply(child,cfg,{}); await flush(); assert.equal(recovered.status,'fulfilled');
 f.app.dispose();
});

test('REGRESSION: competing options wait for acquisition then return their own bounded page without changing provider', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f);
 const a=track(f.app.rpc('thread/resume',{threadId:'different-options',modelProvider:'openai',model:'first-model',excludeTurns:true}));
 const b=track(f.app.rpc('thread/resume',{threadId:'different-options',modelProvider:'custom',model:'requested-model',excludeTurns:true,initialTurnsPage:{limit:100,sortDirection:'asc',itemsView:'summary'}}));
 await flush(); const resumes=child.writes.filter(row=>row.method==='thread/resume');
 assert.equal(resumes.length,1); assert.equal(child.writes.filter(row=>row.method==='thread/read').length,0);
 reply(child,resumes[0],{thread:{id:'different-options',turns:[]},model:'first-model',modelProvider:'openai'}); await flush();
 assert.equal(a.status,'fulfilled'); assert.equal(b.status,'pending','incompatible caller must not receive first unpaged result');
 const metadata=child.writes.filter(row=>row.method==='thread/read').at(-1); assert.ok(metadata);
 reply(child,metadata,{thread:{id:'different-options',model:'first-model',modelProvider:'historical',turns:[]}}); await flush();
 const page=child.writes.filter(row=>row.method==='thread/turns/list').at(-1); assert.ok(page);
 assert.equal(page.params.limit,10); assert.equal(page.params.sortDirection,'asc'); assert.equal(page.params.itemsView,'summary');
 reply(child,page,{data:[{id:'caller-page'}],nextCursor:'opaque-cursor'}); await flush();
 assert.equal(b.status,'fulfilled'); assert.equal(b.value.modelProvider,'openai'); assert.equal(b.value.model,'first-model');
 assert.equal(b.value.initialTurnsPage.data[0].id,'caller-page'); assert.equal(b.value.initialTurnsPage.nextCursor,'opaque-cursor');
 assert.equal(child.writes.filter(row=>row.method==='thread/resume').length,1);
 f.app.dispose();
});

test('REGRESSION: child and preflight use the same resolved SQLite home', async()=>{
 const f=fixture();const config=f.app.buildAppServerConfig();
 assert.ok(config.args.includes('sqlite_home="/fixture-sqlite-home"'));
});
test('REGRESSION: successful late resume remains attached rather than reacquiring the writer',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const timed=track(f.app.rpc('thread/resume',{threadId:'late-owned',excludeTurns:true}));await flush();
 const req=child.writes.find(r=>r.method==='thread/resume');f.timers.find(t=>t.active&&t.ms===120000).callback();await flush();
 assert.equal(timed.status,'rejected');reply(child,req,{thread:{id:'late-owned'},modelProvider:'openai',model:'actual'});await flush();
 const reopened=track(f.app.rpc('thread/resume',{threadId:'late-owned',excludeTurns:true}));await flush();
 assert.equal(child.writes.filter(r=>r.method==='thread/resume').length,1);
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);assert.ok(read);reply(child,read,{thread:{id:'late-owned',turns:[]}});await flush();assert.equal(reopened.status,'fulfilled');
});

test('REGRESSION: file mutation refuses unowned writers before any file callback',async()=>{
 const f=fixture(); let writes=0;
 const state=track(f.app.withThreadFileMutation('foreign',async()=>{writes++;})); await flush();
 assert.equal(state.status,'rejected'); assert.match(state.error,/writer ownership/);
 assert.equal(writes,0); assert.equal(f.children.length,0);
});
test('REGRESSION: config drift and dispose preserve a joined writer while reads remain usable',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const acquired=track(f.app.rpc('thread/resume',{threadId:'owned',excludeTurns:true}));await flush();
 reply(child,child.writes.find(r=>r.method==='thread/resume'),{thread:{id:'owned',status:{type:'inProgress'}},modelProvider:'openai',model:'actual'});await flush();
 f.changeConfig(); const reading=track(f.app.rpc('thread/read',{threadId:'owned',includeTurns:false}));await flush();
 assert.equal(child.killed,false,'config drift must not SIGTERM a joined writer');assert.equal(f.children.length,1);
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);assert.ok(read);
 reply(child,read,{thread:{id:'owned',status:{type:'inProgress'}}});await flush();assert.equal(reading.status,'fulfilled');
 f.app.dispose();assert.equal(child.killed,false,'explicit dispose must be gated too');
 const start=track(f.app.rpc('turn/start',{threadId:'owned'}));await flush();assert.equal(start.status,'rejected');assert.match(start.error,/configuration.*deferred/);
 const interrupt=track(f.app.rpc('turn/interrupt',{threadId:'owned',turnId:'active'}));await flush();
 const irq=child.writes.filter(r=>r.method==='turn/interrupt').at(-1);assert.ok(irq);reply(child,irq,{});await flush();assert.equal(interrupt.status,'fulfilled');
});

test('REGRESSION: dispose during pending writer acquisition preserves the child',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const pending=track(f.app.rpc('thread/resume',{threadId:'acquiring',excludeTurns:true}));await flush();
 f.app.dispose();assert.equal(child.killed,false);
});
test.each(['idle','inProgress'])('REGRESSION: file callback requires locally owned idle status %s',async(status)=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const resume=track(f.app.rpc('thread/resume',{threadId:'owned-files',excludeTurns:true}));await flush();
 reply(child,child.writes.find(r=>r.method==='thread/resume'),{thread:{id:'owned-files'},modelProvider:'openai'});await flush();
 let writes=0;const mutation=track(f.app.withThreadFileMutation('owned-files',async()=>{writes++;}));await flush();
 const req=child.writes.filter(r=>r.method==='thread/read').at(-1);assert.ok(req);
 reply(child,req,{thread:{id:'owned-files',status:{type:status}}});await flush();
 assert.equal(mutation.status,status==='idle'?'fulfilled':'rejected');assert.equal(writes,status==='idle'?1:0);
});

test('REGRESSION: dispose during pending thread/start preserves possible writer',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const pending=track(f.app.rpc('thread/start',{}));await flush();f.app.dispose();assert.equal(child.killed,false);
});
test('REGRESSION: transport rechecks file mutation lease after asynchronous setup',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);f.app.fileMutationsByThreadId.add('guard');
 const before=child.writes.length;const pending=track(f.app.call('turn/start',{threadId:'guard'}));await flush();
 assert.equal(pending.status,'rejected');assert.equal(child.writes.length,before);
});

test('REGRESSION: cold page requests are capped before writer acquisition',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const pending=track(f.app.rpc('thread/resume',{threadId:'bounded-cold',excludeTurns:true,initialTurnsPage:{limit:50000,sortDirection:'desc',itemsView:'full'}}));await flush();
 const req=child.writes.find(r=>r.method==='thread/resume');assert.equal(req.params.initialTurnsPage.limit,10);
 reply(child,req,{thread:{id:'bounded-cold'}});await flush();
});

test('REGRESSION: explicit writer release lets deferred config restart on the next read',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const resume=track(f.app.rpc('thread/resume',{threadId:'released',excludeTurns:true}));await flush();
 reply(child,child.writes.find(r=>r.method==='thread/resume'),{thread:{id:'released'},modelProvider:'openai'});await flush();
 f.changeConfig();const released=track(f.app.rpc('thread/unsubscribe',{threadId:'released'}));await flush();
 reply(child,child.writes.find(r=>r.method==='thread/unsubscribe'),{});await flush();assert.equal(released.status,'fulfilled');
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',method:'thread/closed',params:{threadId:'released'}})+'\n');await flush();
 const read=track(f.app.rpc('config/read',{}));await flush();assert.equal(f.children.length,2);
 const replacement=f.children[1];reply(replacement,initializeRequest(replacement));await flush();
 const req=replacement.writes.find(r=>r.method==='config/read');assert.ok(req);reply(replacement,req,{});await flush();assert.equal(read.status,'fulfilled');f.app.dispose();
});
test('REGRESSION: attached process retains its inspected SQLite directory after config drift',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 assert.equal(f.app.activeSQLiteHome,'/fixture-sqlite-home');
});

test('REGRESSION: clean config replacement inspects the new database before dispatch',async()=>{
 const checks=[];const f=fixture({checks});const old=await healthyInitializedChild(f);f.changeConfig();
 const pending=track(f.app.rpc('thread/resume',{threadId:'new-db',excludeTurns:true}));await flush();
 assert.equal(checks[0][2],'/replacement-sqlite-home');
});

test('REGRESSION: writer response closes the dispose race before RPC continuation runs',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const pending=track(f.app.rpc('thread/start',{}));await flush();
 reply(child,child.writes.find(r=>r.method==='thread/start'),{thread:{id:'response-owned'},modelProvider:'openai'});
 f.app.dispose();assert.equal(child.killed,false);await flush();assert.equal(pending.status,'fulfilled');
});

test('REGRESSION: managed SQLite home mismatch is rejected before resume dispatch',async()=>{
 const f=fixture({verifySQLiteHome:true});const child=await healthyInitializedChild(f);
 const pending=track(f.app.rpc('thread/resume',{threadId:'managed-home',excludeTurns:true}));await flush();
 const verify=child.writes.filter(r=>r.method==='config/read').at(-1);
 assert.ok(verify && verify!==child.writes.find(r=>r.method==='config/read'),'effective config must be verified after initialize');
 reply(child,verify,{config:{sqlite_home:'/managed-different-home'}});await flush();
 assert.equal(pending.status,'rejected');assert.match(pending.error,/effective SQLite home/);
 assert.equal(child.writes.filter(r=>r.method==='thread/resume').length,0);
});

test('REGRESSION: duplicate cold resumes share one supported writer acquisition', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f);
 const params={threadId:'coalesced',excludeTurns:true};
 const a=track(f.app.rpc('thread/resume',params));
 const b=track(f.app.rpc('thread/resume',params)); await flush();
 const requests=child.writes.filter(row=>row.method==='thread/resume');
 assert.equal(requests.length,1);
 reply(child,requests[0],{thread:{id:'coalesced'},model:'gpt-5.4',modelProvider:'openai'}); await flush();
 assert.equal(a.status,'fulfilled'); assert.equal(b.status,'fulfilled'); f.app.dispose();
});




test.each(['thread/start','turn/start'])('CLOSURE: deferred config is rechecked after initialization await before %s dispatch',async(method)=>{
 const f=fixture();const child=await healthyInitializedChild(f);f.app.joinedThreads.set('owned',{});
 const ensure=f.app.ensureInitialized.bind(f.app);
 f.app.ensureInitialized=async()=>{await ensure();f.app.configChangeDeferred=true;};
 const pending=track(f.app.rpc(method,{threadId:'owned'}));await flush();
 assert.equal(pending.status,'rejected');assert.match(pending.error,/configuration.*deferred/);
 assert.equal(child.writes.filter(r=>r.method===method).length,0);assert.equal(child.killed,false);
});
test('CLOSURE: deferred config is rechecked after idle-status reply before file callback',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);f.app.joinedThreads.set('files',{});
 let writes=0;const pending=track(f.app.withThreadFileMutation('files',async()=>{writes++;}));await flush();
 const req=child.writes.filter(r=>r.method==='thread/read').at(-1);assert.ok(req);
 reply(child,req,{thread:{id:'files',status:{type:'idle'}}});f.app.configChangeDeferred=true;await flush();
 assert.equal(pending.status,'rejected');assert.match(pending.error,/configuration.*deferred/);assert.equal(writes,0);
});

test('CLOSURE: in-progress unsubscribe acknowledgement preserves writer lifetime during config drift',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const acquired=track(f.app.rpc('thread/resume',{threadId:'lifetime',excludeTurns:true}));await flush();
 reply(child,child.writes.find(r=>r.method==='thread/resume'),{thread:{id:'lifetime',status:{type:'inProgress'}},modelProvider:'openai'});await flush();
 f.changeConfig();const unsub=track(f.app.rpc('thread/unsubscribe',{threadId:'lifetime'}));await flush();reply(child,child.writes.find(r=>r.method==='thread/unsubscribe'),{});await flush();
 const reading=track(f.app.rpc('config/read',{}));await flush();assert.equal(child.killed,false,'unsubscribe ACK does not close writer');assert.equal(f.children.length,1);
 reply(child,child.writes.filter(r=>r.method==='config/read').at(-1),{});await flush();assert.equal(reading.status,'fulfilled');f.app.dispose();assert.equal(child.killed,false);
});

test('CLOSURE: incompatible queued resume evaluates its own valid options after definitive invalid-params rejection',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);
 const a=track(f.app.rpc('thread/resume',{threadId:'invalid-first',excludeTurns:true,model:'bad'}));
 const b=track(f.app.rpc('thread/resume',{threadId:'invalid-first',excludeTurns:true,model:'good'}));await flush();
 const first=child.writes.find(r=>r.method==='thread/resume');child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:first.id,error:{code:-32602,message:'Invalid model options'}})+'\n');await flush();
 assert.equal(a.status,'rejected');const second=child.writes.filter(r=>r.method==='thread/resume')[1];assert.ok(second,'valid caller gets evaluated after non-acquisition');assert.equal(second.params.model,'good');
 reply(child,second,{thread:{id:'invalid-first'},model:'good',modelProvider:'openai'});await flush();assert.equal(b.status,'fulfilled');
});
