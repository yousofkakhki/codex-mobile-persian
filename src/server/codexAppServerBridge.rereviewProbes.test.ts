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


test('rereview: inherited YOLO must not outrank a newer restrictive hot read', async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const id='own-order';seedOwned(f,id);
 await stage(f,child,id,{approvalPolicy:'never',sandbox:'danger-full-access'});
 const hot=track(f.app.rpc('thread/resume',{threadId:id,excludeTurns:true,approvalPolicy:'on-request',sandbox:'read-only'}));await flush();const read=child.writes.filter(x=>x.method==='thread/read').at(-1);
 const turn=track(f.app.rpc('turn/start',{threadId:id,input:[]}));await flush();const req=child.writes.filter(x=>x.method==='turn/start').at(-1);reply(child,req,{});await flush();
 reply(child,read,{thread:{id,status:{type:'idle'}}});await flush();assert.equal(hot.status,'fulfilled');
 const pending=f.app.pendingHotPermissionsByThreadId.get(id);
 const next=track(f.app.rpc('turn/start',{threadId:id,input:[]}));await flush();const nextReq=child.writes.filter(x=>x.method==='turn/start').at(-1);assert.ok(nextReq);
 console.log(JSON.stringify({probe:'inherited-intent-order',hot,acceptedOrder:f.app.acceptedPermissionOrderByThreadId.get(id),pending,nextTurnPayload:nextReq.params}));
 assert.equal(pending?.approvalPolicy,'on-request','newer explicit hot restriction must survive inherited old choice consumed by omitted turn');
 assert.equal(pending?.sandboxPolicy?.type,'readOnly');
});
test('rereview: synchronous settings rejection must not retain pre-ack snapshot intent or consume restrictions',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const id='own-pre-ack';seedOwned(f,id);
 await stage(f,child,id,{approvalPolicy:'on-request',sandbox:'read-only'});
 const edit=track(f.app.rpc('thread/settings/update',{threadId:id,approvalPolicy:'never',permissions:':read-only',sandboxPolicy:{type:'readOnly',networkAccess:false}}));await flush();const req=child.writes.filter(x=>x.method==='thread/settings/update').at(-1);
 // A prior settings/turn operation can deliver this real native builtin snapshot before this invalid request is rejected.
 notify(child,'thread/settings/updated',{threadId:id,threadSettings:{approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},activePermissionProfile:{id:':read-only',extends:null}}});
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32602,message:'`permissions` cannot be combined with `sandboxPolicy`'}})+'\n');await flush();
 const next=track(f.app.rpc('turn/start',{threadId:id,input:[]}));await flush();const dispatched=child.writes.filter(x=>x.method==='turn/start').at(-1);assert.ok(dispatched);
 console.log(JSON.stringify({probe:'pre-ack-rejection',edit,intent:f.app.permissionIntentByThreadId.get(id),staged:f.app.pendingHotPermissionsByThreadId.get(id),nextTurnPayload:dispatched.params}));
 assert.equal(edit.status,'rejected');assert.equal(f.app.permissionIntentByThreadId.has(id),false,'rejected request cannot become accepted intent');
 assert.equal(f.app.pendingHotPermissionsByThreadId.get(id)?.approvalPolicy,'on-request');
});
test('rereview: thread/start response followed by closure must not revive writer ownership',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const id='own-new-closed';
 const start=track(f.app.rpc('thread/start',{approvalPolicy:'on-request',sandbox:'read-only'}));await flush();const req=child.writes.filter(x=>x.method==='thread/start').at(-1);
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:req.id,result:{thread:{id},approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'thread/closed',params:{threadId:id}})+'\n');await flush();
 console.log(JSON.stringify({probe:'start-samechunk-close',start,joined:f.app.joinedThreads.has(id),writer:f.app.writerThreadIds.has(id),intent:f.app.permissionIntentByThreadId.get(id)}));
 assert.equal(f.app.joinedThreads.has(id),false,'closed returned acquisition cannot be resurrected by continuation');assert.equal(f.app.writerThreadIds.has(id),false);
});
test('rereview: known-effective no-op settings must not leave dependent dispatch permanently blocked',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const id='own-noop';seedOwned(f,id,{approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}});
 const edit=track(f.app.rpc('thread/settings/update',{threadId:id,approvalPolicy:'on-request'}));await flush();reply(child,child.writes.filter(x=>x.method==='thread/settings/update').at(-1),{});await flush();
 const turn=track(f.app.rpc('turn/start',{threadId:id,input:[]}));await flush();
 console.log(JSON.stringify({probe:'native-no-op-gate',edit,turn,pending:f.app.pendingPermissionSettingsById.size}));
 assert.notEqual(turn.status,'rejected','native success repeating known-effective settings emits no event and needs confirmation/reconciliation');
 assert.ok(child.writes.some(x=>x.method==='turn/start'));
});
