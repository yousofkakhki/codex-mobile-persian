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


for (const dimension of ['approvalPolicy', 'sandbox']) {
 test(`cycle2 S2: inherited ${dimension} preserves its staged order while another caller field advances`, async () => {
  const f=fixture();const child=await healthyInitializedChild(f);const id='cycle2-order-'+dimension;seedOwned(f,id);
  await stage(f,child,id,{approvalPolicy:'never',sandbox:'danger-full-access'});
  const hot=track(f.app.rpc('thread/resume',{threadId:id,excludeTurns:true,...(dimension==='approvalPolicy'?{approvalPolicy:'on-request'}:{sandbox:'read-only'})}));await flush();
  const read=child.writes.filter(x=>x.method==='thread/read').at(-1);
  const turn=track(f.app.rpc('turn/start',{threadId:id,input:[],...(dimension==='approvalPolicy'?{sandboxPolicy:{type:'dangerFullAccess'}}:{approvalPolicy:'never'})}));await flush();
  const req=child.writes.filter(x=>x.method==='turn/start').at(-1);reply(child,req,{});await flush();assert.equal(turn.status,'fulfilled');
  reply(child,read,{thread:{id}});await flush();assert.equal(hot.status,'fulfilled');
  const pending=f.app.pendingHotPermissionsByThreadId.get(id);
  if(dimension==='approvalPolicy') {assert.equal(pending?.approvalPolicy,'on-request');assert.equal(pending?.sandboxPolicy,undefined);}
  else {assert.equal(pending?.sandboxPolicy?.type,'readOnly');assert.equal(pending?.approvalPolicy,undefined);}
  assert.equal(f.app.acceptedPermissionOrderByThreadId.get(id)[dimension],1);
 });
}

test('cycle2 L2: an early matching settings snapshot remains unaccepted until synchronous success', async () => {
 const f=fixture();const child=await healthyInitializedChild(f);const id='cycle2-preack-success';seedOwned(f,id);
 await stage(f,child,id,{approvalPolicy:'on-request',sandbox:'read-only'});
 const edit=track(f.app.rpc('thread/settings/update',{threadId:id,approvalPolicy:'untrusted'}));await flush();const req=child.writes.filter(x=>x.method==='thread/settings/update').at(-1);
 notify(child,'thread/settings/updated',{threadId:id,threadSettings:{approvalPolicy:'untrusted',sandboxPolicy:{type:'readOnly',networkAccess:false}}});await flush();
 assert.equal(f.app.permissionIntentByThreadId.has(id),false);
 assert.equal(f.app.pendingHotPermissionsByThreadId.get(id)?.approvalPolicy,'on-request');
 assert.equal(f.app.pendingPermissionSettingsById.size,1);
 reply(child,req,{});await flush();assert.equal(edit.status,'fulfilled');
 assert.equal(f.app.permissionIntentByThreadId.get(id)?.approvalPolicy,true);
 assert.equal(f.app.pendingHotPermissionsByThreadId.get(id)?.approvalPolicy,undefined);
 assert.equal(f.app.pendingHotPermissionsByThreadId.get(id)?.sandboxPolicy?.type,'readOnly');
 assert.equal(f.app.pendingPermissionSettingsById.size,0);
});
test('cycle2 L2: early asynchronous rejection cannot be overwritten by later matching snapshot and queued ack', async () => {
 const f=fixture();const child=await healthyInitializedChild(f);const id='cycle2-preack-error';seedOwned(f,id);
 await stage(f,child,id,{approvalPolicy:'on-request',sandbox:'read-only'});
 const edit=track(f.app.rpc('thread/settings/update',{threadId:id,approvalPolicy:'never'}));await flush();const req=child.writes.filter(x=>x.method==='thread/settings/update').at(-1);
 notify(child,'error',{threadId:id,error:{message:'invalid thread settings override: rejected fixture'},willRetry:false});
 notify(child,'thread/settings/updated',{threadId:id,threadSettings:{approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}}});await flush();
 reply(child,req,{});await flush();assert.equal(edit.status,'fulfilled');
 assert.equal(f.app.permissionIntentByThreadId.has(id),false);
 assert.equal(f.app.pendingHotPermissionsByThreadId.get(id)?.approvalPolicy,'on-request');
 assert.equal(f.app.pendingPermissionSettingsById.size,0);
});

for (const method of ['thread/start','thread/resume']) {
 test(`cycle2 L3: ${method} closure between response and continuation rejects without restoring any writer state`, async () => {
  const f=fixture();const child=await healthyInitializedChild(f);const id='cycle2-close-'+method;
  const acquire=track(f.app.rpc(method,{...(method==='thread/resume'?{threadId:id,excludeTurns:true}:{}),approvalPolicy:'on-request',sandbox:'read-only'}));await flush();const req=child.writes.filter(x=>x.method===method).at(-1);assert.ok(req);
  child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:req.id,result:{thread:{id},approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'thread/closed',params:{threadId:id}})+'\n');await flush();
  assert.equal(acquire.status,'rejected');assert.equal(f.app.joinedThreads.has(id),false);assert.equal(f.app.writerThreadIds.has(id),false);assert.equal(f.app.permissionIntentByThreadId.has(id),false);
  assert.equal(child.killed,false);
 });
}

for (const shape of ['typed readOnly','typed workspaceWrite','builtin :read-only','builtin :workspace']) {
 test(`cycle2 L2: exact native no-op ${shape} releases its application gate without a settings event`, async () => {
  const f=fixture();const child=await healthyInitializedChild(f);const id='cycle2-noop-'+shape;
  const sandbox=shape.includes('workspace')?{type:'workspaceWrite',writableRoots:['/fixture'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false};
  const profile=shape.startsWith('builtin')?shape.slice(8):null;
  const acquire=track(f.app.rpc('thread/start',{approvalPolicy:'on-request',sandbox:'read-only'}));await flush();
  reply(child,child.writes.filter(x=>x.method==='thread/start').at(-1),{thread:{id},approvalPolicy:'on-request',sandbox,...(profile?{activePermissionProfile:{id:profile,extends:null}}:{})});await flush();assert.equal(acquire.status,'fulfilled');
  const edit=track(f.app.rpc('thread/settings/update',{threadId:id,approvalPolicy:'on-request',...(profile?{permissions:profile}:{sandboxPolicy:sandbox})}));await flush();
  reply(child,child.writes.filter(x=>x.method==='thread/settings/update').at(-1),{});await flush();assert.equal(edit.status,'fulfilled');
  assert.equal(f.app.pendingPermissionSettingsById.size,0);
  const next=track(f.app.rpc('turn/start',{threadId:id,input:[]}));await flush();const turn=child.writes.filter(x=>x.method==='turn/start').at(-1);assert.ok(turn);reply(child,turn,{});await flush();assert.equal(next.status,'fulfilled');
  assert.equal(child.writes.some(x=>['thread/resume','turn/interrupt','thread/unsubscribe'].includes(x.method)),false);
 });
}
for (const source of ['turn in flight','turn ack without application','unmatched settings event']) {
 test(`cycle2 L2: stale joined metadata after ${source} cannot prove a queued settings no-op`, async () => {
  const f=fixture();const child=await healthyInitializedChild(f);const id='cycle2-stale-'+source;seedOwned(f,id,{approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}});
  if(source==='unmatched settings event') notify(child,'thread/settings/updated',{threadId:id,threadSettings:{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}});
  else {
   const first=track(f.app.rpc('turn/start',{threadId:id,input:[],approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}));await flush();
   if(source==='turn ack without application') {reply(child,child.writes.filter(x=>x.method==='turn/start').at(-1),{});await flush();assert.equal(first.status,'fulfilled');}
  }
  const edit=track(f.app.rpc('thread/settings/update',{threadId:id,approvalPolicy:'on-request'}));await flush();reply(child,child.writes.filter(x=>x.method==='thread/settings/update').at(-1),{});await flush();
  assert.equal(edit.status,'fulfilled');assert.equal(f.app.pendingPermissionSettingsById.size,1);assert.equal(f.app.permissionIntentByThreadId.get(id)?.approvalPolicy,source==='turn ack without application'?true:undefined);
  const count=child.writes.length;const next=track(f.app.rpc('turn/start',{threadId:id,input:[]}));await flush();assert.equal(next.status,'rejected');assert.equal(child.writes.length,count);
 });
}
test('cycle2 L2: exact no-op evidence is invalidated by another settings-changing RPC before ack', async () => {
 const f=fixture();const child=await healthyInitializedChild(f);const id='cycle2-noop-race';seedOwned(f,id,{approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}});
 const edit=track(f.app.rpc('thread/settings/update',{threadId:id,approvalPolicy:'on-request'}));await flush();const req=child.writes.filter(x=>x.method==='thread/settings/update').at(-1);
 const changing=track(f.app.rpc('turn/settings/update',{threadId:id,turnId:'fixture',approvalPolicy:'never'}));await flush();assert.ok(child.writes.some(x=>x.method==='turn/settings/update'));
 reply(child,req,{});await flush();assert.equal(edit.status,'fulfilled');assert.equal(f.app.pendingPermissionSettingsById.size,1);assert.equal(f.app.permissionIntentByThreadId.has(id),false);
});

test('cycle2 L2: a buffered pre-ack application snapshot cannot survive an intervening changing RPC', async () => {
 const f=fixture();const child=await healthyInitializedChild(f);const id='cycle2-preack-interference';seedOwned(f,id);
 await stage(f,child,id,{approvalPolicy:'on-request',sandbox:'read-only'});
 const edit=track(f.app.rpc('thread/settings/update',{threadId:id,approvalPolicy:'never'}));await flush();const req=child.writes.filter(x=>x.method==='thread/settings/update').at(-1);
 notify(child,'thread/settings/updated',{threadId:id,threadSettings:{approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}}});await flush();
 const changing=track(f.app.rpc('turn/settings/update',{threadId:id,turnId:'fixture',approvalPolicy:'untrusted'}));await flush();
 reply(child,req,{});await flush();assert.equal(edit.status,'fulfilled');
 assert.equal(f.app.pendingPermissionSettingsById.size,1);assert.equal(f.app.permissionIntentByThreadId.has(id),false);assert.equal(f.app.pendingHotPermissionsByThreadId.get(id)?.approvalPolicy,'on-request');
});
