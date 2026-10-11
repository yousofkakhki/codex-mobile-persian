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

test('sparse consecutive hot permission requests retain each explicit dimension for the next turn', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='hot-sparse';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,{}); f.app.writerThreadIds.add(threadId);
 for(const overrides of [{approvalPolicy:'on-request'},{sandbox:'read-only'}]) {
  const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,...overrides})); await flush();
  reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId}}); await flush(); assert.equal(hot.status,'fulfilled');
 }
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.equal(turn.params.approvalPolicy,'on-request'); assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

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


test('default YOLO overrides stale permissions on a cold resume without a settings mutation', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f);
 const params={threadId:'cold-default-yolo',excludeTurns:true,initialTurnsPage:{limit:50000,sortDirection:'desc',itemsView:'full'},model:'fixture-model',modelProvider:'fixture-provider'};
 const state=track(f.app.rpc('thread/resume',params)); await flush();
 const request=child.writes.find(row=>row.method==='thread/resume');
 assert.ok(request);
 assert.equal(request.params.approvalPolicy,'never');
 assert.equal(request.params.sandbox,'danger-full-access');
 assert.equal(request.params.initialTurnsPage.limit,10);
 assert.equal(request.params.model,params.model);
 assert.equal(request.params.modelProvider,params.modelProvider);
 assert.equal(Object.hasOwn(params,'approvalPolicy'),false,'caller object is not mutated');
 assert.equal(child.writes.filter(row=>row.method==='thread/settings/update').length,0);
 reply(child,request,{thread:{id:params.threadId},approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}); await flush();
 assert.equal(state.status,'fulfilled'); assert.equal(child.killed,false);
});

test('fresh thread start carries the default permission pair without extra native calls', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f);
 const before=child.writes.length;
 const params={cwd:'/fixture-project',model:'fixture-model',config:{model_reasoning_effort:'high'}};
 const state=track(f.app.rpc('thread/start',params)); await flush();
 const request=child.writes.find(row=>row.method==='thread/start'); assert.ok(request);
 assert.equal(request.params.approvalPolicy,'never');
 assert.equal(request.params.sandbox,'danger-full-access');
 assert.equal(child.writes.length-before,1);
 assert.equal(Object.hasOwn(params,'sandbox'),false);
 reply(child,request,{thread:{id:'fresh-default'}}); await flush(); assert.equal(state.status,'fulfilled');
});

test('hot rejoin remains read-only then the next owner-started turn defaults to YOLO', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='hot-default';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome;
 // The already loaded writer can carry old effective permissions: a rejoin must not mutate it.
 f.app.joinedThreads.set(threadId,{approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false},model:'old-model'});
 f.app.writerThreadIds.add(threadId);
 const before=child.writes.length;
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
 const read=child.writes.filter(row=>row.method==='thread/read').at(-1); assert.ok(read);
 reply(child,read,{thread:{id:threadId,status:{type:'inProgress'}}}); await flush();
 assert.equal(hot.status,'fulfilled'); assert.equal(hot.value.approvalPolicy,'on-request');
 assert.deepEqual(child.writes.slice(before).map(row=>row.method),['thread/read']);
 const input=[{type:'text',text:'new owner turn'}]; const params={threadId,input,model:'new-model',effort:'high'};
 const turn=track(f.app.rpc('turn/start',params)); await flush();
 const request=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(request);
 assert.equal(request.params.approvalPolicy,'never');
 assert.deepEqual(request.params.sandboxPolicy,{type:'dangerFullAccess'});
 assert.equal(Object.hasOwn(request.params,'sandbox'),false,'turn/start uses sandboxPolicy, never sandbox');
 assert.deepEqual(request.params.input,input); assert.equal(request.params.effort,'high');
 assert.equal(Object.hasOwn(params,'sandboxPolicy'),false);
 assert.deepEqual(child.writes.slice(before).map(row=>row.method),['thread/read','turn/start']);
 assert.equal(child.killed,false);
 reply(child,request,{turn:{id:'next-turn'}}); await flush(); assert.equal(turn.status,'fulfilled');
});

test('explicit constrained permissions on acquisition survive later default turns', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='restricted-acquisition';
 const params={threadId,excludeTurns:true,approvalPolicy:'on-request',sandbox:'read-only'};
 const resumed=track(f.app.rpc('thread/resume',params)); await flush();
 const request=child.writes.find(row=>row.method==='thread/resume');
 assert.equal(request.params.approvalPolicy,'on-request'); assert.equal(request.params.sandbox,'read-only');
 reply(child,request,{thread:{id:threadId},approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}}); await flush();
 assert.equal(resumed.status,'fulfilled');
 const turn=track(f.app.rpc('turn/start',{threadId,input:[{type:'text',text:'retain restriction'}]})); await flush();
 const next=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(next);
 assert.equal(Object.hasOwn(next.params,'approvalPolicy'),false,'omission retains native sticky explicit approval');
 assert.equal(Object.hasOwn(next.params,'sandboxPolicy'),false,'omission retains native sticky explicit sandbox');
 reply(child,next,{turn:{id:'restricted-turn'}}); await flush(); assert.equal(turn.status,'fulfilled');
});

test('an explicit turn restriction remains sticky on later turns', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='later-restricted';
 const acquired=track(f.app.rpc('thread/start',{})); await flush();
 reply(child,child.writes.find(row=>row.method==='thread/start'),{thread:{id:threadId}}); await flush();
 const explicit={threadId,input:[],approvalPolicy:'untrusted',sandboxPolicy:{type:'readOnly',networkAccess:false}};
 const first=track(f.app.rpc('turn/start',explicit)); await flush();
 const firstRequest=child.writes.filter(row=>row.method==='turn/start').at(-1);
 assert.equal(firstRequest.params.approvalPolicy,'untrusted'); assert.deepEqual(firstRequest.params.sandboxPolicy,explicit.sandboxPolicy);
 reply(child,firstRequest,{turn:{id:'restricted'}}); await flush(); assert.equal(first.status,'fulfilled');
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const request=child.writes.filter(row=>row.method==='turn/start').at(-1);
 assert.equal(Object.hasOwn(request.params,'approvalPolicy'),false);
 assert.equal(Object.hasOwn(request.params,'sandboxPolicy'),false);
 reply(child,request,{turn:{id:'still-restricted'}}); await flush(); assert.equal(next.status,'fulfilled');
});

test('named permission profiles never receive incompatible sandbox or approval defaults', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='permission-profile';
 const resumed=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,permissions:'restricted-profile'})); await flush();
 const request=child.writes.find(row=>row.method==='thread/resume'); assert.ok(request);
 assert.equal(request.params.permissions,'restricted-profile');
 assert.equal(Object.hasOwn(request.params,'sandbox'),false);
 assert.equal(Object.hasOwn(request.params,'approvalPolicy'),false);
 reply(child,request,{thread:{id:threadId}}); await flush(); assert.equal(resumed.status,'fulfilled');
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);
 assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false); assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test.each([
 {sandbox_mode:'read-only',approval_policy:'on-request'},
 {approval_policy:'untrusted'},
 {sandbox_mode:'workspace-write',sandbox_workspace_write:{network_access:false}},
 {profile:'restricted-config-profile'},
 {permissions:{default_profile:'restricted-modern-profile'}},
 {permissions:{profiles:{'restricted-modern-profile':{}}}},
])('explicit config permission overrides retain native config semantics: %j', async config => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='config-restricted';
 const resumed=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,config})); await flush();
 const request=child.writes.find(row=>row.method==='thread/resume'); assert.ok(request);
 assert.deepEqual(request.params.config,config);
 assert.equal(Object.hasOwn(request.params,'sandbox'),false,'config permissions must not compete with RPC defaults');
 assert.equal(Object.hasOwn(request.params,'approvalPolicy'),false);
 reply(child,request,{thread:{id:threadId}}); await flush(); assert.equal(resumed.status,'fulfilled');
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);
 assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false); assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test.each([
 {sandbox_mode:'read-only',approval_policy:'on-request'},
 {sandbox_mode:'workspace-write',approval_policy:'untrusted'},
 {sandbox_mode:'danger-full-access',approval_policy:'on-request'},
])('RPC defaults honor the launched restricted runtime config: %j', async runtime => {
 const f=fixture({runtime}); const child=await healthyInitializedChild(f); const threadId='runtime-restricted';
 const resumed=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
 const request=child.writes.find(row=>row.method==='thread/resume'); assert.ok(request);
 assert.equal(request.params.sandbox,runtime.sandbox_mode); assert.equal(request.params.approvalPolicy,runtime.approval_policy);
 const nativeWorkspacePolicy={type:'workspaceWrite',writableRoots:['/fixture-native-root'],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:true};
 reply(child,request,{thread:{id:threadId},sandbox:runtime.sandbox_mode==='workspace-write' ? nativeWorkspacePolicy : undefined}); await flush(); assert.equal(resumed.status,'fulfilled');
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.equal(turn.params.approvalPolicy,runtime.approval_policy);
 if(runtime.sandbox_mode==='danger-full-access') assert.deepEqual(turn.params.sandboxPolicy,{type:'dangerFullAccess'});
 else if(runtime.sandbox_mode==='read-only') assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
 else assert.deepEqual(turn.params.sandboxPolicy,nativeWorkspacePolicy,'preserve native restricted roots/network instead of inventing policy');
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test('a timed-out restricted acquisition retains its explicit permission intent on late success', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='late-restricted';
 const resumed=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,approvalPolicy:'on-request',sandbox:'read-only'})); await flush();
 const request=child.writes.find(row=>row.method==='thread/resume'); assert.ok(request);
 f.timers.find(timer=>timer.active && timer.ms===120000).callback(); await flush(); assert.equal(resumed.status,'rejected');
 reply(child,request,{thread:{id:threadId},approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}}); await flush();
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);
 assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false);
 assert.equal(child.writes.filter(row=>row.method==='thread/resume').length,1); assert.equal(child.killed,false);
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test('permission intent reflects the dispatched payload when the caller edits it during the response await', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='captured-restriction';
 const params={threadId,excludeTurns:true,approvalPolicy:'on-request',sandbox:'read-only'};
 const resumed=track(f.app.rpc('thread/resume',params)); await flush();
 const request=child.writes.find(row=>row.method==='thread/resume'); assert.ok(request);
 delete params.approvalPolicy; delete params.sandbox;
 reply(child,request,{thread:{id:threadId}}); await flush(); assert.equal(resumed.status,'fulfilled');
 const turn=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const next=child.writes.filter(row=>row.method==='turn/start').at(-1);
 assert.equal(Object.hasOwn(next.params,'approvalPolicy'),false); assert.equal(Object.hasOwn(next.params,'sandboxPolicy'),false);
 reply(child,next,{}); await flush(); assert.equal(turn.status,'fulfilled');
});
test('hot rejoin does not erase restrictions explicitly selected on the owned writer', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='hot-restricted';
 const resumed=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,permissions:'restricted-profile'})); await flush();
 reply(child,child.writes.find(row=>row.method==='thread/resume'),{thread:{id:threadId},approvalPolicy:'on-request'}); await flush();
 const before=child.writes.length;
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
 reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId,status:{type:'inProgress'}}}); await flush();
 assert.equal(hot.status,'fulfilled'); assert.deepEqual(child.writes.slice(before).map(row=>row.method),['thread/read']);
 const turn=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const next=child.writes.filter(row=>row.method==='turn/start').at(-1);
 assert.equal(Object.hasOwn(next.params,'approvalPolicy'),false); assert.equal(Object.hasOwn(next.params,'sandboxPolicy'),false);
 reply(child,next,{}); await flush(); assert.equal(turn.status,'fulfilled');
});

test('restricted runtime permission drift blocks turns until release and only the replacement adopts it', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='generation-bound';
 const resumed=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
 reply(child,child.writes.find(row=>row.method==='thread/resume'),{thread:{id:threadId}}); await flush();
 f.changeRuntime({approval_policy:'on-request',sandbox_mode:'read-only'});
 const before=child.writes.length;
 const denied=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 assert.equal(denied.status,'rejected'); assert.match(denied.error,/configuration.*deferred/);
 assert.equal(child.writes.length,before); assert.equal(child.killed,false);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
 reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId,status:{type:'inProgress'}}}); await flush();
 assert.equal(hot.status,'fulfilled'); assert.equal(child.writes.filter(row=>row.method==='thread/resume').length,1);
 const released=track(f.app.rpc('thread/unsubscribe',{threadId})); await flush();
 reply(child,child.writes.find(row=>row.method==='thread/unsubscribe'),{}); await flush();
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',method:'thread/closed',params:{threadId}})+'\n'); await flush();
 const refreshed=track(f.app.rpc('config/read',{})); await flush();
 const replacement=f.children[1]; assert.ok(replacement); reply(replacement,initializeRequest(replacement)); await flush();
 reply(replacement,replacement.writes.find(row=>row.method==='config/read'),{}); await flush(); assert.equal(refreshed.status,'fulfilled');
 const fresh=track(f.app.rpc('thread/start',{})); await flush();
 const start=replacement.writes.find(row=>row.method==='thread/start'); assert.ok(start);
 assert.equal(start.params.approvalPolicy,'on-request'); assert.equal(start.params.sandbox,'read-only');
 reply(replacement,start,{thread:{id:'replacement-restricted'}}); await flush(); assert.equal(fresh.status,'fulfilled');
 assert.equal(f.app.permissionIntentByThreadId.has(threadId),false);
});

test('hot caller permission constraints wait for the next requested turn instead of mutating the active writer', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='hot-requested-restriction';
 const acquired=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
 reply(child,child.writes.find(row=>row.method==='thread/resume'),{thread:{id:threadId},sandbox:{type:'dangerFullAccess'},approvalPolicy:'never'}); await flush();
 const before=child.writes.length;
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,sandbox:'read-only',approvalPolicy:'on-request'})); await flush();
 reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId,status:{type:'inProgress'}}}); await flush();
 assert.equal(hot.status,'fulfilled'); assert.equal(hot.value.approvalPolicy,'never','hot metadata must report the unchanged active writer');
 assert.deepEqual(child.writes.slice(before).map(row=>row.method),['thread/read']);
 const turn=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const next=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(next);
 assert.equal(next.params.approvalPolicy,'on-request');
 assert.deepEqual(next.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
 assert.deepEqual(child.writes.slice(before).map(row=>row.method),['thread/read','turn/start']);
 reply(child,next,{}); await flush(); assert.equal(turn.status,'fulfilled');
 const later=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const retained=child.writes.filter(row=>row.method==='turn/start').at(-1);
 assert.equal(Object.hasOwn(retained.params,'approvalPolicy'),false); assert.equal(Object.hasOwn(retained.params,'sandboxPolicy'),false);
 reply(child,retained,{}); await flush(); assert.equal(later.status,'fulfilled');
});

test.each([
 {sandbox:'workspace-write'},
 {config:{sandbox_mode:'read-only'}},
 {sandbox:'not-a-native-mode'},
 {permissions:'profile',sandbox:'read-only'},
])('unsupported hot permission request fails visibly before any read or mutation: %j', async overrides => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='hot-invalid';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome;
 f.app.joinedThreads.set(threadId,{}); f.app.writerThreadIds.add(threadId);
 const before=child.writes.length;
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,...overrides})); await flush();
 assert.equal(hot.status,'rejected'); assert.match(hot.error,/permission|sandbox/i);
 assert.equal(child.writes.length,before); assert.equal(child.killed,false);
});

test('the next turn explicit profile replaces a staged hot sandbox without incompatible fields', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='replace-hot';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,{}); f.app.writerThreadIds.add(threadId);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,sandbox:'read-only'})); await flush();
 reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId}}); await flush(); assert.equal(hot.status,'fulfilled');
 const next=track(f.app.rpc('turn/start',{threadId,input:[],permissions:'explicit-next-profile'})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.equal(turn.params.permissions,'explicit-next-profile'); assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false);
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test('the next turn explicit sandbox replaces a staged profile without incompatible fields', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='replace-hot-profile';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,{}); f.app.writerThreadIds.add(threadId);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,permissions:'hot-profile'})); await flush();
 reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId}}); await flush(); assert.equal(hot.status,'fulfilled');
 const sandboxPolicy={type:'readOnly',networkAccess:false};
 const next=track(f.app.rpc('turn/start',{threadId,input:[],sandboxPolicy})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.deepEqual(turn.params.sandboxPolicy,sandboxPolicy); assert.equal(Object.hasOwn(turn.params,'permissions'),false);
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test('restricted runtime read-only applies to an already loaded legacy full-access writer on next turn', async () => {
 const f=fixture({runtime:{sandbox_mode:'read-only',approval_policy:'on-request'}}); const child=await healthyInitializedChild(f); const threadId='hot-runtime-readonly';
 f.app.joinedThreads.set(threadId,{sandbox:{type:'dangerFullAccess'}}); f.app.writerThreadIds.add(threadId);
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.equal(turn.params.approvalPolicy,'on-request'); assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test('workspace runtime uses the native returned roots and fails closed for an incompatible loaded writer', async () => {
 const f=fixture({runtime:{sandbox_mode:'workspace-write',approval_policy:'on-request'}}); const child=await healthyInitializedChild(f); const threadId='runtime-workspace';
 const policy={type:'workspaceWrite',writableRoots:['/fixture-project','/fixture-extra'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
 const resumed=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
 reply(child,child.writes.find(row=>row.method==='thread/resume'),{thread:{id:threadId},sandbox:policy}); await flush();
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.deepEqual(turn.params.sandboxPolicy,policy,'native workspace roots and network must remain exact');
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
 f.app.joinedThreads.set('legacy-full',{sandbox:{type:'dangerFullAccess'}}); f.app.writerThreadIds.add('legacy-full');
 const before=child.writes.length;
 const denied=track(f.app.rpc('turn/start',{threadId:'legacy-full',input:[]})); await flush();
 assert.equal(denied.status,'rejected'); assert.match(denied.error,/workspace.*permission/i);
 assert.equal(child.writes.length,before); assert.equal(child.killed,false);
});

test('explicit thread settings permission edits remain sticky instead of later default-turn escalation', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='settings-restricted';
 const acquired=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
 reply(child,child.writes.find(row=>row.method==='thread/resume'),{thread:{id:threadId}}); await flush();
 const params={threadId,sandboxPolicy:{type:'readOnly',networkAccess:false},approvalPolicy:'on-request'};
 const edited=track(f.app.rpc('thread/settings/update',params)); await flush();
 const request=child.writes.find(row=>row.method==='thread/settings/update'); assert.deepEqual(request.params,params);
 reply(child,request,{}); await flush(); assert.equal(edited.status,'fulfilled','native response acknowledges enqueue only');
 assert.equal(f.app.permissionIntentByThreadId.get(threadId)?.sandbox === true,false,'queued ack is not applied permission intent');
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',method:'thread/settings/updated',params:{threadId,threadSettings:{approvalPolicy:params.approvalPolicy,sandboxPolicy:params.sandboxPolicy}}})+'\n'); await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(f.app.permissionIntentByThreadId.get(threadId))),{approvalPolicy:true,sandbox:true},'only the applied snapshot confirms both explicit dimensions');
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false); assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test('late successful turn consumes its staged hot override before a newer permission choice', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='late-hot-turn';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,{}); f.app.writerThreadIds.add(threadId);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,sandbox:'read-only',approvalPolicy:'on-request'})); await flush();
 reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId}}); await flush();
 const first=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const request=child.writes.filter(row=>row.method==='turn/start').at(-1);
 f.timers.find(timer=>timer.active&&timer.ms===120000).callback(); await flush(); assert.equal(first.status,'rejected');
 reply(child,request,{}); await flush();
 assert.equal(f.app.pendingHotPermissionsByThreadId.has(threadId),false,'late response must consume the applied staged override');
 const chosen=track(f.app.rpc('turn/start',{threadId,input:[],permissions:'newer-restricted-profile'})); await flush();
 reply(child,child.writes.filter(row=>row.method==='turn/start').at(-1),{}); await flush(); assert.equal(chosen.status,'fulfilled');
 const later=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false);
 assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);
 reply(child,turn,{}); await flush(); assert.equal(later.status,'fulfilled');
});

test('later default turns add no permission discovery RPC, retry, settings write, or approval reply', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='bounded-overhead';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,{}); f.app.writerThreadIds.add(threadId);
 const before=child.writes.length;
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:800,method:'item/commandExecution/requestApproval',params:{threadId,command:'pending-owner-review'}})+'\n');
 for(let index=0;index<25;index++) {
  const turn=track(f.app.rpc('turn/start',{threadId,input:[{type:'text',text:`requested-${index}`}]})); await flush();
  const request=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(request);
  assert.equal(request.params.approvalPolicy,'never'); assert.deepEqual(request.params.sandboxPolicy,{type:'dangerFullAccess'});
  reply(child,request,{}); await flush(); assert.equal(turn.status,'fulfilled');
 }
 assert.equal(child.writes.length-before,25); assert.equal(child.writes.slice(before).every(row=>row.method==='turn/start'),true);
 assert.equal(f.app.listPendingServerRequests().length,1,'YOLO defaults must not resolve queued owner approval requests');
 assert.equal(f.app.permissionRequestsById.size,0); assert.equal(child.killed,false);
 console.log(JSON.stringify({case:'permission-defaults-no-per-turn-fanout',requestedTurns:25,nativeCalls:child.writes.length-before,extraPermissionRPCs:0,pendingApprovals:1}));
});

test('failed permission edits do not become sticky and permission intent remains scoped to the returned thread', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='failed-restriction';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,{}); f.app.writerThreadIds.add(threadId);
 const failed=track(f.app.rpc('turn/start',{threadId,input:[],permissions:'missing-profile'})); await flush();
 const request=child.writes.filter(row=>row.method==='turn/start').at(-1);
 child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'Unknown permissions profile'}})+'\n'); await flush();
 assert.equal(failed.status,'rejected'); assert.equal(f.app.permissionRequestsById.size,0);
 const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1);
 assert.equal(turn.params.approvalPolicy,'never'); assert.deepEqual(turn.params.sandboxPolicy,{type:'dangerFullAccess'});
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

test('nullable no-override turn fields cannot erase staged explicit hot restrictions', async () => {
 const f=fixture(); const child=await healthyInitializedChild(f); const threadId='hot-null-no-override';
 f.app.confirmedSQLiteHome=f.app.activeSQLiteHome; f.app.joinedThreads.set(threadId,{}); f.app.writerThreadIds.add(threadId);
 const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,sandbox:'read-only',approvalPolicy:'on-request'})); await flush();
 reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId}}); await flush();
 const next=track(f.app.rpc('turn/start',{threadId,input:[],approvalPolicy:null,sandboxPolicy:null,permissions:null})); await flush();
 const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
 assert.equal(turn.params.approvalPolicy,'on-request'); assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
 reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
});

for(const method of ['thread/start','thread/resume']) {
 test.each([
  {default_permissions:':read-only'},
  {'default_permissions.id':':read-only'},
  {profile:'restricted',profiles:{restricted:{default_permissions:':read-only'}}},
  {'profiles.restricted.default_permissions':':read-only'},
  {'permissions.restricted.filesystem':{read:[],write:[]}},
  {'sandbox_workspace_write.network_access':false},
  {approval_policy:{granular:{sandbox_approval:false,rules:false,skill_approval:false}}},
 ])(`native config aliases preserve explicit acquisition intent through hot rejoin and later turns: ${method} %j`, async config => {
  const f=fixture(); const child=await healthyInitializedChild(f); const threadId=`config-alias-${method}`;
  const params={...(method==='thread/resume' ? {threadId,excludeTurns:true} : {}),config};
  const acquired=track(f.app.rpc(method,params)); await flush();
  const request=child.writes.find(row=>row.method===method); assert.ok(request);
  assert.deepEqual(request.params.config,config); assert.equal(Object.hasOwn(request.params,'sandbox'),false); assert.equal(Object.hasOwn(request.params,'approvalPolicy'),false);
  reply(child,request,{thread:{id:threadId},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'on-request'}); await flush(); assert.equal(acquired.status,'fulfilled');
  f.app.confirmedSQLiteHome=f.app.activeSQLiteHome;
  const hot=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true})); await flush();
  reply(child,child.writes.filter(row=>row.method==='thread/read').at(-1),{thread:{id:threadId,status:{type:'inProgress'}}}); await flush(); assert.equal(hot.status,'fulfilled');
  const next=track(f.app.rpc('turn/start',{threadId,input:[]})); await flush();
  const turn=child.writes.filter(row=>row.method==='turn/start').at(-1); assert.ok(turn);
  assert.equal(Object.hasOwn(turn.params,'sandboxPolicy'),false); assert.equal(Object.hasOwn(turn.params,'approvalPolicy'),false);
  reply(child,turn,{}); await flush(); assert.equal(next.status,'fulfilled');
  const before=child.writes.length;
  const changed=track(f.app.rpc('thread/resume',{threadId,excludeTurns:true,config})); await flush();
  assert.equal(changed.status,'rejected','hot explicit config cannot be silently shadowed or reported applied'); assert.match(changed.error,/permission config/);
  assert.equal(child.writes.length,before); assert.equal(child.killed,false);
 });
}
