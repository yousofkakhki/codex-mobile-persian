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

test('integration: item projection stays bounded and read-only during a deferred configuration change', async () => {
 const f=fixture();const child=await healthyInitializedChild(f);seedOwned(f,'activity-owned');f.app.configChangeDeferred=true;
 const reading=track(f.app.rpc('thread/items/list',{threadId:'activity-owned',limit:100,sortDirection:'desc'}));await flush();
 const request=child.writes.filter(row=>row.method==='thread/items/list').at(-1);assert.ok(request,'bounded item read must remain available without a resume');
 reply(child,request,{data:[],nextCursor:null});await flush();assert.equal(reading.status,'fulfilled');
 assert.equal(child.writes.some(row=>['thread/resume','turn/start','thread/unsubscribe'].includes(row.method)),false);
});
test('integration: closing a writer during telemetry pre-dispatch cannot authorize a delayed interrupt', async () => {
 const f=fixture();const child=await healthyInitializedChild(f);seedOwned(f,'telemetry-close');
 let release;const gate=new Promise(resolve=>{release=resolve});
 f.app.setActivityRecorder({beforeRpc:()=>gate,afterRpc:async()=>{},rpcFailed:async()=>{},notification:()=>{}});
 const interrupt=track(f.app.rpc('turn/interrupt',{threadId:'telemetry-close',turnId:'turn'}));await flush();
 const sent=child.writes.find(row=>row.method==='turn/interrupt');assert.ok(sent,'telemetry disk latency must not delay an already authorized interrupt');
 reply(child,sent,{});await flush();assert.equal(interrupt.status,'fulfilled');
 notify(child,'thread/closed',{threadId:'telemetry-close'});release('fixture');await flush();
 assert.equal(child.writes.filter(row=>row.method==='turn/interrupt').length,1,'settling telemetry must never replay a closed writer mutation');
 assert.equal(child.killed,false);
});
