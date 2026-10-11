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

// Independent safety expectations, not regression assertions that reproduce the implementation.
function notify(child, method, params) { child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',method,params})+'\n'); }
function seedOwned(f, threadId, meta={}) { f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,meta); f.app.writerThreadIds.add(threadId); }
async function stage(f, child, threadId, permissions) {
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,...permissions})); await flush();
 const read=child.writes.filter(row=>row.method==='thread/read').at(-1); assert.ok(read);
 reply(child,read,{thread:{id:threadId,status:{type:'idle'}}}); await flush(); assert.equal(hot.status,'fulfilled');
}
for(const method of ['thread/start','thread/resume','turn/start']) {
 test(`independent: legacy launcher on-failure must not become invalid typed ${method} policy`, async () => {
  const f=fixture({runtime:{approval_policy:'on-failure',sandbox_mode:'read-only'}}); const child=await healthyInitializedChild(f); const threadId='legacy-'+method;
  if(method==='turn/start') seedOwned(f,threadId,{sandbox:{type:'readOnly',networkAccess:false}});
  const pending=track(f.app.rpc(method,method==='thread/start' ? {} : {threadId,...(method==='thread/resume'?{excludeTurns:true}:{input:[]})})); await flush();
  const req=child.writes.filter(row=>row.method===method).at(-1); assert.ok(req);
  console.log(JSON.stringify({probe:'legacy-on-failure-'+method,payload:req.params}));
  assert.notEqual(req.params.approvalPolicy,'on-failure','Pinned typed AskForApproval excludes on-failure; leave explicit legacy launch policy untouched instead of translating it to an invalid payload');
 });
}
test('independent: hot permission staging must not survive closure during its read await',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='hot-close';seedOwned(f,threadId,{sandbox:{type:'readOnly',networkAccess:false}});f.app.permissionIntentByThreadId.set(threadId,{approvalPolicy:true,sandbox:true});
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,approvalPolicy:'never',sandbox:'danger-full-access'}));await flush();
 const read=child.writes.filter(row=>row.method==='thread/read').at(-1);assert.ok(read);
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:read.id,result:{thread:{id:threadId,status:{type:'idle'}}}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'thread/closed',params:{threadId}})+'\n');await flush();
 console.log(JSON.stringify({probe:'closed-hot-stage',status:hot.status,joined:f.app.joinedThreads.has(threadId),staged:f.app.pendingHotPermissionsByThreadId.get(threadId)}));
 const reacquired=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,approvalPolicy:'on-request',sandbox:'read-only'}));await flush();
 const resume=child.writes.filter(row=>row.method==='thread/resume').at(-1);assert.ok(resume);reply(child,resume,{thread:{id:threadId},approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}});await flush();assert.equal(reacquired.status,'fulfilled');
 const next=track(f.app.rpc('turn/start',{threadId,input:[]}));await flush();const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);assert.ok(turn);
 console.log(JSON.stringify({probe:'closed-hot-reacquire-next-turn',payload:turn.params}));
 assert.notEqual(turn.params.sandboxPolicy?.type,'dangerFullAccess','staging from a closed writer must not override a freshly accepted restrictive acquisition');
});
test('independent: a completed hot read must not stage into the next child generation',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='hot-generation';seedOwned(f,threadId);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,sandbox:'danger-full-access',approvalPolicy:'never'}));await flush();const read=child.writes.filter(row=>row.method==='thread/read').at(-1);assert.ok(read);
 reply(child,read,{thread:{id:threadId,status:{type:'idle'}}});child.emit('exit');
 const fresh=track(f.app.rpc('config/read',{}));const replacement=f.children[1];assert.ok(replacement);reply(replacement,initializeRequest(replacement));await flush();
 console.log(JSON.stringify({probe:'cross-generation-hot-stage',status:hot.status,staged:f.app.pendingHotPermissionsByThreadId.get(threadId),children:f.children.length}));
 assert.equal(f.app.pendingHotPermissionsByThreadId.has(threadId),false,'retired generation cannot repopulate new generation staging');
});
test('independent: confirmed newer restricted settings supersede earlier staged YOLO',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='newer-settings';seedOwned(f,threadId);
 await stage(f,child,threadId,{sandbox:'danger-full-access',approvalPolicy:'never'});
 const edited=track(f.app.rpc('thread/settings/update',{threadId,approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}}));await flush();const settings=child.writes.filter(row=>row.method==='thread/settings/update').at(-1);assert.ok(settings);reply(child,settings,{});
 notify(child,'thread/settings/updated',{threadId,threadSettings:{approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}}});await flush();assert.equal(edited.status,'fulfilled');
 const next=track(f.app.rpc('turn/start',{threadId,input:[]}));await flush();const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);assert.ok(turn);
 console.log(JSON.stringify({probe:'newer-restricted-settings',payload:turn.params}));
 assert.notEqual(turn.params.sandboxPolicy?.type,'dangerFullAccess','an older staged choice must not broaden a newer confirmed restrictive setting');
 assert.notEqual(turn.params.approvalPolicy,'never');
});
test('independent: settings queued ack is not confirmed accepted permission intent',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='queued-settings';seedOwned(f,threadId,{approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}});
 const edited=track(f.app.rpc('thread/settings/update',{threadId,approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}}));await flush();const settings=child.writes.filter(row=>row.method==='thread/settings/update').at(-1);assert.ok(settings);reply(child,settings,{});await flush();
 notify(child,'error',{threadId,error:{message:'invalid thread settings override: fixture asynchronous rejection',codexErrorInfo:'badRequest'},willRetry:false});await flush();
 const next=track(f.app.rpc('turn/start',{threadId,input:[]}));await flush();const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);assert.ok(turn);
 console.log(JSON.stringify({probe:'settings-queued-not-applied',status:edited.status,retained:f.app.permissionIntentByThreadId.get(threadId),nextPayload:turn.params,appliedNotifications:0}));
 assert.equal(f.app.permissionIntentByThreadId.get(threadId)?.sandbox===true,false,'an enqueue-only ack followed by asynchronous rejection must not become permanently accepted permission intent');
});
test('independent: an old settings reply must not repopulate closed thread permission intent',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);const threadId='settings-close';seedOwned(f,threadId);
 const edited=track(f.app.rpc('thread/settings/update',{threadId,sandboxPolicy:{type:'readOnly',networkAccess:false}}));await flush();const settings=child.writes.filter(row=>row.method==='thread/settings/update').at(-1);assert.ok(settings);
 notify(child,'thread/closed',{threadId});reply(child,settings,{});await flush();
 console.log(JSON.stringify({probe:'closed-late-settings-ack',retained:f.app.permissionIntentByThreadId.get(threadId),joined:f.app.joinedThreads.has(threadId)}));
 assert.equal(f.app.permissionIntentByThreadId.has(threadId),false,'same process is insufficient: reply must be bound to the still-owned thread epoch');
});
