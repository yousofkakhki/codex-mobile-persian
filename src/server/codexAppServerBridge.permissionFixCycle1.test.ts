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
  let runtime = { ...(options.runtime ?? {}) };
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
    buildAppServerArgs: () => ['app-server', '-c', `fixture_revision=${revision}`, ...Object.entries(runtime).flatMap(([key,value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
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
  return { app, children, timers, changeConfig: () => { revision += 1; }, changeRuntime: next => { runtime = { ...next }; } };
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


function notify(child, method, params) { child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',method,params})+'\n'); }
function seedOwned(f, threadId, meta={}) { f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,meta); f.app.writerThreadIds.add(threadId); }
async function stage(f, child, threadId, permissions) {
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,...permissions})); await flush();
 const read=child.writes.filter(row=>row.method==='thread/read').at(-1); assert.ok(read);
 reply(child,read,{thread:{id:threadId,status:{type:'idle'}}}); await flush(); assert.equal(hot.status,'fulfilled');
}

for(const method of ['thread/start','thread/resume','turn/start']) {
 test(`cycle1 L1: legacy launch policy stays native with omitted typed ${method} approval`, async () => {
  const f=fixture({runtime:{approval_policy:'on-failure',sandbox_mode:'read-only'}}); const child=await healthyInitializedChild(f); const threadId='legacy-'+method;
  if(method==='turn/start') seedOwned(f,threadId,{sandbox:{type:'readOnly',networkAccess:false}});
  const pending=track(f.app.rpc(method,method==='thread/start' ? {} : {threadId,...(method==='thread/resume'?{excludeTurns:true}:{input:[]})})); await flush();
  const req=child.writes.filter(row=>row.method===method).at(-1); assert.ok(req);
  assert.equal(Object.hasOwn(req.params,'approvalPolicy'),false,'do not substitute never or another typed policy for explicit legacy launch policy');
  assert.equal(f.app.activePermissionDefaults.approvalPolicy,'on-failure','exact launcher snapshot is unchanged');
  if(method==='turn/start') assert.deepEqual(req.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
  else assert.equal(req.params.sandbox,'read-only');
  reply(child,req,method==='turn/start'?{}:{thread:{id:threadId}}); await flush(); assert.equal(pending.status,'fulfilled'); assert.equal(child.killed,false);
 });
}

test('cycle1 S1: a closed hot read is rejected without staging or writer reacquisition',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='cycle1-hot-close';seedOwned(f,threadId);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,approvalPolicy:'never',sandbox:'danger-full-access'}));await flush();
 const read=child.writes.filter(row=>row.method==='thread/read').at(-1);assert.ok(read);
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:read.id,result:{thread:{id:threadId,status:{type:'idle'}}}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'thread/closed',params:{threadId}})+'\n');await flush();
 assert.equal(hot.status,'rejected');assert.equal(f.app.pendingHotPermissionsByThreadId.has(threadId),false);assert.equal(f.app.joinedThreads.has(threadId),false);assert.equal(child.killed,false);
 assert.equal(child.writes.some(row=>['thread/resume','turn/interrupt','thread/unsubscribe'].includes(row.method)),false);
});
test('cycle1 S1: closure during the bounded page await invalidates the hot completion',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='cycle1-page-close';seedOwned(f,threadId);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,initialTurnsPage:{limit:50000},sandbox:'read-only'}));await flush();
 reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId}});await flush();
 const page=child.writes.filter(row=>row.method==='thread/turns/list').at(-1);assert.ok(page);assert.equal(page.params.limit,10);
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:page.id,result:{data:[]}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'thread/closed',params:{threadId}})+'\n');await flush();
 assert.equal(hot.status,'rejected');assert.equal(f.app.pendingHotPermissionsByThreadId.has(threadId),false);assert.equal(child.killed,false);
});
test('cycle1 L3: old turn completion cannot restore intent after same-chunk closure',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='cycle1-turn-close';seedOwned(f,threadId);
 const turn=track(f.app.rpc('turn/start',{threadId,input:[],approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}}));await flush();
 const req=child.writes.filter(row=>row.method==='turn/start').at(-1);assert.ok(req);
 notify(child,'thread/closed',{threadId});reply(child,req,{});await flush();
 assert.equal(f.app.permissionIntentByThreadId.has(threadId),false);assert.equal(f.app.permissionRequestsById.size,0);assert.equal(turn.status,'rejected');assert.equal(child.killed,false);
});

test('cycle1 L2: queued permission settings stay pending and cannot be shadowed by a next turn',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='cycle1-queued';seedOwned(f,threadId);
 const edit=track(f.app.rpc('thread/settings/update',{threadId,approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}}));await flush();
 const req=child.writes.filter(row=>row.method==='thread/settings/update').at(-1);reply(child,req,{});await flush();assert.equal(edit.status,'fulfilled','{} is only the native queued ack');
 assert.equal(f.app.permissionIntentByThreadId.has(threadId),false,'ack must not claim application');
 const before=child.writes.length;const turn=track(f.app.rpc('turn/start',{threadId,input:[]}));await flush();assert.equal(turn.status,'rejected');assert.match(turn.error,/permission.*pending|settings.*pending/i);assert.equal(child.writes.length,before);
 notify(child,'thread/settings/updated',{threadId:'unrelated',threadSettings:{approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}}});await flush();assert.equal(f.app.permissionIntentByThreadId.has(threadId),false);
 notify(child,'thread/settings/updated',{threadId,threadSettings:{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}});await flush();assert.equal(f.app.permissionIntentByThreadId.has(threadId),false,'unmatched snapshot does not confirm caller intent');
 notify(child,'thread/settings/updated',{threadId,threadSettings:{approvalPolicy:'on-request',sandboxPolicy:{networkAccess:false,type:'readOnly'}}});await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(f.app.permissionIntentByThreadId.get(threadId))),{approvalPolicy:true,sandbox:true});
 const next=track(f.app.rpc('turn/start',{threadId,input:[]}));await flush();const applied=child.writes.filter(row=>row.method==='turn/start').at(-1);assert.ok(applied);
 assert.equal(Object.hasOwn(applied.params,'approvalPolicy'),false);assert.equal(Object.hasOwn(applied.params,'sandboxPolicy'),false);reply(child,applied,{});await flush();assert.equal(next.status,'fulfilled');assert.equal(child.killed,false);
});
test('cycle1 L2: asynchronous settings rejection releases pending work without discarding accepted restrictions',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='cycle1-settings-error';seedOwned(f,threadId);f.app.permissionIntentByThreadId.set(threadId,{approvalPolicy:true,sandbox:false});
 const edit=track(f.app.rpc('thread/settings/update',{threadId,sandboxPolicy:{type:'readOnly',networkAccess:false}}));await flush();const req=child.writes.filter(row=>row.method==='thread/settings/update').at(-1);reply(child,req,{});await flush();
 notify(child,'error',{threadId,error:{message:'invalid thread settings override: fixture asynchronous rejection',codexErrorInfo:'badRequest'},willRetry:false});await flush();
 assert.deepEqual(f.app.permissionIntentByThreadId.get(threadId),{approvalPolicy:true,sandbox:false});
 const next=track(f.app.rpc('turn/start',{threadId,input:[]}));await flush();const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);assert.ok(turn);assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);assert.deepEqual(turn.params.sandboxPolicy,{type:'dangerFullAccess'});reply(child,turn,{});await flush();assert.equal(next.status,'fulfilled');
});
for(const changed of ['approvalPolicy','sandbox']) {
 test(`cycle1 S2: newer confirmed sparse ${changed} supersedes only its older staged dimension`,async()=>{
  const f=fixture();const child=await healthyInitializedChild(f);const threadId='cycle1-sparse-'+changed;seedOwned(f,threadId);
  await stage(f,child,threadId,{approvalPolicy:'on-request',sandbox:'read-only'});
  const settings=changed==='approvalPolicy'?{approvalPolicy:'untrusted'}:{sandboxPolicy:{type:'readOnly',networkAccess:false}};
  const edit=track(f.app.rpc('thread/settings/update',{threadId,...settings}));await flush();const req=child.writes.filter(row=>row.method==='thread/settings/update').at(-1);reply(child,req,{});notify(child,'thread/settings/updated',{threadId,threadSettings:{approvalPolicy:'untrusted',sandboxPolicy:{type:'readOnly',networkAccess:false}}});await flush();
  const next=track(f.app.rpc('turn/start',{threadId,input:[]}));await flush();const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);assert.ok(turn);
  if(changed==='approvalPolicy'){assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});}
  else {assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false);assert.equal(turn.params.approvalPolicy,'on-request');}
  reply(child,turn,{});await flush();assert.equal(next.status,'fulfilled');assert.equal(child.killed,false);
 });
}
test('cycle1 S2: newer confirmed settings beat a still-awaiting older hot read',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='cycle1-settings-during-read';seedOwned(f,threadId);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,approvalPolicy:'never',sandbox:'danger-full-access'}));await flush();const read=child.writes.filter(row=>row.method==='thread/read').at(-1);
 const edit=track(f.app.rpc('thread/settings/update',{threadId,approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}}));await flush();const req=child.writes.filter(row=>row.method==='thread/settings/update').at(-1);reply(child,req,{});notify(child,'thread/settings/updated',{threadId,threadSettings:{approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}}});await flush();reply(child,read,{thread:{id:threadId}});await flush();assert.equal(hot.status,'fulfilled');
 const next=track(f.app.rpc('turn/start',{threadId,input:[]}));await flush();const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);assert.ok(turn);assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false);reply(child,turn,{});await flush();assert.equal(next.status,'fulfilled');
});
