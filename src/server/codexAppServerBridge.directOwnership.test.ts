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
    child.stdin = { write: (line) => { const request = JSON.parse(line); child.writes.push(request); if(request.method==='thread/goal/clear') child.goalCleared=true; if (request.method === 'thread/goal/get') queueMicrotask(() => reply(child,request,{goal:child.goalCleared?null:{threadId:'owned',objective:'Existing',status:'paused',tokenBudget:50,tokensUsed:5,timeUsedSeconds:12,createdAt:1,updatedAt:2}})); if (!options.verifySQLiteHome && request.method === 'config/read' && request.params?.includeLayers === false) queueMicrotask(() => reply(child,request,{config:{sqlite_home:revision ? '/replacement-sqlite-home':'/fixture-sqlite-home'}})); return true; }, end: () => {} };
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
const mutations = ['thread/goal/set', 'thread/goal/clear', 'turn/interrupt', 'thread/rollback'];
function mutationParams(method) { return method === 'thread/goal/set' ? { threadId: 'owned', status: 'paused' } : method === 'thread/goal/clear' ? { threadId: 'owned' } : { threadId: 'owned', turnId: 'active', numTurns: 1 }; }
test.each(mutations)('direct %s rejects integrity mismatch on an acquired writer', async method => {
  const options = {}; const f = fixture(options); const child = await healthyInitializedChild(f);
  await acquire(f, child); options.integrityFailure = 'Thread history integrity mismatch: active writer preserved';
  const state = track(f.app.rpc(method, mutationParams(method))); await flush();
  assert.equal(child.writes.filter(r => r.method === method).length, 0, 'integrity mismatch cannot dispatch mutation');
  assert.equal(state.status, 'rejected'); assert.match(state.error, /history integrity mismatch/);
  assert.equal(child.killed, false);
});
test.each(mutations)('direct %s refuses an unowned thread without acquiring a writer', async method => {
  const f = fixture(); const child = await healthyInitializedChild(f);
  const state = track(f.app.rpc(method, { threadId: 'foreign', turnId: 'active', numTurns: 1 })); await flush();
  assert.equal(child.writes.filter(r => r.method === method).length, 0, 'no unowned mutation dispatch');
  assert.equal(state.status, 'rejected'); assert.match(state.error, /writer ownership/);
  assert.equal(child.writes.filter(r => r.method === 'thread/resume' || r.method === 'thread/start').length, 0);
});


test.each(mutations.flatMap(method => ['thread-closed', 'writer-lost', 'process-swap', 'target-changed'].map(reason => [method, reason])))('direct %s rechecks %s after integrity await', async (method, reason) => {
  const options = {}; const f = fixture(options); const child = await healthyInitializedChild(f); await acquire(f, child);
  let release; const gate = new Promise(resolve => { release = resolve; }); options.integrityGate = () => gate;
  const params = mutationParams(method);
  const state = track(f.app.rpc(method, params)); await flush();
  if (reason === 'thread-closed') child.stdout.emit('data', JSON.stringify({ method: 'thread/closed', params: { threadId: 'owned' } }) + '\n');
  if (reason === 'writer-lost') f.app.writerThreadIds.delete('owned');
  if (reason === 'process-swap') f.app.process = { ...child };
  if (reason === 'target-changed') params.threadId = 'foreign';
  release(); await flush();
  assert.equal(child.writes.filter(r => r.method === method).length, 0, 'await cannot retire ownership or generation');
  if (reason === 'target-changed' && method.startsWith('thread/goal/')) {
    assert.equal(child.writes.some(r => r.params?.threadId === 'foreign'), false);
    const read=child.writes.filter(r=>r.method==='thread/read').at(-1);reply(child,read,{thread:{id:'owned',status:{type:'idle'}}});await flush();
    reply(child,child.writes.filter(r=>r.method===method).at(-1),{success:true});await flush();assert.equal(state.status,'fulfilled');
  } else assert.equal(state.status, 'rejected');
});


test.each(mutations.flatMap(method => ['initialization', 'sqlite-home'].map(boundary => [method, boundary])))('direct %s rechecks ownership after %s await', async (method, boundary) => {
  const fixtureOptions = {}; const f = fixture(fixtureOptions); const child = await healthyInitializedChild(f); await acquire(f, child);
  fixtureOptions.verifySQLiteHome = true;
  if (boundary === 'initialization') f.app.initialized = false;
  else f.app.confirmedSQLiteHome = '';
  const state = track(f.app.rpc(method, mutationParams(method))); await flush();
  const req = child.writes.filter(r => r.method === (boundary === 'initialization' ? 'initialize' : 'config/read')).at(-1);
  // Stop the actual continuation at its microtask boundary; do not replace ensureInitialized.
  if (boundary === 'initialization') reply(child, req);
  child.stdout.emit('data', JSON.stringify({ method: 'thread/closed', params: { threadId: 'owned' } }) + '\n');
  if (boundary !== 'initialization') reply(child, req, { config: { sqlite_home: '/fixture-sqlite-home' } });
  await flush();
  assert.equal(child.writes.filter(r => r.method === method).length, 0);
  assert.equal(state.status, 'rejected');
});
test.each(['thread/goal/set', 'thread/goal/clear', 'thread/rollback'])('direct %s requires an owned idle thread before mutation', async method => {
  const f = fixture(); const child = await healthyInitializedChild(f); await acquire(f, child);
  const state = track(f.app.rpc(method, method === 'thread/goal/set' ? { threadId: 'owned', status: 'active' } : mutationParams(method))); await flush();
  const read = child.writes.filter(r => r.method === 'thread/read').at(-1);
  assert.ok(read, 'idle state must be read before Goal/rollback dispatch');
  reply(child, read, { thread: { id: 'owned', status: { type: 'inProgress' } } }); await flush();
  assert.equal(child.writes.filter(r => r.method === method).length, 0); assert.equal(state.status, 'rejected');
});


test.each(['thread/goal/set', 'thread/goal/clear', 'thread/rollback'].flatMap(method => ['thread-closed', 'process-swap', 'deferred-config', 'quarantine', 'file-lease', 'competing-turn'].map(reason => [method, reason])))('direct %s rechecks %s after idle read', async (method, reason) => {
  const f = fixture(); const child = await healthyInitializedChild(f); await acquire(f, child);
  const state = track(f.app.rpc(method, mutationParams(method))); await flush();
  const read = child.writes.filter(r => r.method === 'thread/read').at(-1); assert.ok(read);
  reply(child, read, { thread: { id: 'owned', status: { type: 'idle' } } });
  if (reason === 'thread-closed') child.stdout.emit('data', JSON.stringify({ method: 'thread/closed', params: { threadId: 'owned' } }) + '\n');
  if (reason === 'process-swap') f.app.process = { ...child };
  if (reason === 'deferred-config') f.changeConfig();
  if (reason === 'quarantine') f.app.timedOutRpcIds.set(999, 'turn/start');
  if (reason === 'file-lease') f.app.fileMutationsByThreadId.add('owned');
  if (reason === 'competing-turn') f.app.pending.set(999, { method: 'turn/start' });
  await flush();
  assert.equal(child.writes.filter(r => r.method === method).length, 0); assert.equal(state.status, 'rejected'); assert.equal(child.killed, false);
});


test.each(mutations.flatMap(method => ['thread/resume', 'thread/start'].map(acquisition => [method, acquisition])))('supported %s succeeds after %s acquisition', async (method, acquisition) => {
  const f = fixture(); const child = await healthyInitializedChild(f); await acquire(f, child, acquisition);
  assert.equal(f.app.joinedThreads.has('owned'), true); assert.equal(f.app.writerThreadIds.has('owned'), true);
  const params = mutationParams(method);
  const state = track(f.app.rpc(method, params)); await flush();
  if (method !== 'turn/interrupt') {
    const read = child.writes.filter(r => r.method === 'thread/read').at(-1); assert.ok(read);
    reply(child, read, { thread: { id: 'owned', status: { type: 'idle' } } }); await flush();
  }
  const request = child.writes.filter(r => r.method === method).at(-1); assert.ok(request);
  assert.equal(JSON.stringify(request.params), JSON.stringify(params)); reply(child, request, { success: true }); await flush();
  assert.equal(state.status, 'fulfilled'); assert.equal(child.killed, false);
});
test('owned active interrupt remains available during deferred config and pending turn start', async () => {
  const f = fixture(); const child = await healthyInitializedChild(f); await acquire(f, child);
  f.changeConfig(); f.app.pending.set(999, { method: 'turn/start' });
  const state = track(f.app.rpc('turn/interrupt', { threadId: 'owned', turnId: 'active' })); await flush();
  assert.equal(child.writes.filter(r => r.method === 'thread/read').length, 0, 'interrupt must not require idle');
  const irq = child.writes.filter(r => r.method === 'turn/interrupt').at(-1); assert.ok(irq); reply(child, irq); await flush();
  assert.equal(state.status, 'fulfilled'); assert.equal(child.killed, false);
});
test.each(['config/read', 'thread/list', 'thread/goal/get', 'thread/read'])('harmless unowned %s does not acquire a writer', async method => {
  const f = fixture(); const child = await healthyInitializedChild(f);
  const state = track(f.app.rpc(method, { threadId: 'foreign', includeTurns: false })); await flush();
  const request = child.writes.filter(r => r.method === method).at(-1); assert.ok(request); reply(child, request); await flush();
  assert.equal(state.status, 'fulfilled'); assert.equal(f.app.joinedThreads.size, 0); assert.equal(f.app.writerThreadIds.size, 0);
});
test('integrity rejection leaves healthy ownership and config/read responsive', async () => {
  const options = {}; const f = fixture(options); const child = await healthyInitializedChild(f); await acquire(f, child);
  options.integrityFailure = 'Thread history integrity mismatch';
  const rejected = track(f.app.rpc('thread/goal/clear', { threadId: 'owned' })); await flush(); assert.equal(rejected.status, 'rejected');
  delete options.integrityFailure;
  const healthy = track(f.app.rpc('turn/interrupt', { threadId: 'owned', turnId: 'active' })); await flush();
  reply(child, child.writes.filter(r => r.method === 'turn/interrupt').at(-1)); await flush(); assert.equal(healthy.status, 'fulfilled');
  const config = track(f.app.rpc('config/read', {})); await flush(); reply(child, child.writes.filter(r => r.method === 'config/read').at(-1)); await flush(); assert.equal(config.status, 'fulfilled');
});
test.each(mutations)('unsubscribed %s cannot rely on writer-lifetime retention', async method => {
  const f = fixture(); const child = await healthyInitializedChild(f); await acquire(f, child);
  const unsubscribe = track(f.app.rpc('thread/unsubscribe', { threadId: 'owned' })); await flush(); reply(child, child.writes.filter(r => r.method === 'thread/unsubscribe').at(-1)); await flush();
  assert.equal(unsubscribe.status, 'fulfilled'); assert.equal(f.app.writerThreadIds.has('owned'), true);
  const state = track(f.app.rpc(method, mutationParams(method))); await flush(); assert.equal(state.status, 'rejected'); assert.equal(child.writes.filter(r => r.method === method).length, 0);
});


test.each(['thread/goal/set', 'thread/goal/clear', 'thread/rollback'])('direct %s refuses a turn starting after idle read resolves', async method => {
  const f = fixture(); const child = await healthyInitializedChild(f); await acquire(f, child);
  const state = track(f.app.rpc(method, mutationParams(method))); await flush();
  reply(child, child.writes.filter(r => r.method === 'thread/read').at(-1), { thread: { id: 'owned', status: { type: 'idle' } } });
  child.stdout.emit('data', JSON.stringify({ method: 'turn/started', params: { threadId: 'owned', turn: { id: 'new-active' } } }) + '\n');
  await flush(); assert.equal(child.writes.filter(r => r.method === method).length, 0); assert.equal(state.status, 'rejected');
});


test.each(mutations.flatMap(method => ['initialization', 'sqlite-home'].map(boundary => [method, boundary])))('direct %s rejects process replacement during actual %s await', async (method, boundary) => {
  const options = {}; const f = fixture(options); const child = await healthyInitializedChild(f); await acquire(f, child);
  options.verifySQLiteHome = true;
  if (boundary === 'initialization') f.app.initialized = false; else f.app.confirmedSQLiteHome = '';
  const state = track(f.app.rpc(method, mutationParams(method))); await flush();
  const req = child.writes.filter(r => r.method === (boundary === 'initialization' ? 'initialize' : 'config/read')).at(-1);
  reply(child, req, boundary === 'initialization' ? {} : { config: { sqlite_home: '/fixture-sqlite-home' } });
  f.app.process = { ...child }; await flush();
  assert.equal(child.writes.filter(r => r.method === method).length, 0); assert.equal(state.status, 'rejected');
});
test.each(mutations)('direct %s rejects quarantine arising during integrity await', async method => {
  const options = {}; const f = fixture(options); const child = await healthyInitializedChild(f); await acquire(f, child);
  let release; const gate = new Promise(resolve => { release = resolve; }); options.integrityGate = () => gate;
  const state = track(f.app.rpc(method, mutationParams(method))); await flush();
  f.app.timedOutRpcIds.set(999, 'turn/start'); release(); await flush();
  assert.equal(child.writes.filter(r => r.method === method).length, 0); assert.equal(state.status, 'rejected'); assert.equal(child.killed, false);
});
test.each(mutations)('direct %s observes config drift during integrity setup', async method => {
  const options = {}; const f = fixture(options); const child = await healthyInitializedChild(f); await acquire(f, child);
  let release; const gate = new Promise(resolve => { release = resolve; }); options.integrityGate = () => gate;
  const state = track(f.app.rpc(method, { threadId: 'owned', turnId: 'active' })); await flush(); f.changeConfig(); release(); await flush();
  const request = child.writes.filter(r => r.method === method).at(-1);
  if (method === 'turn/interrupt') { assert.ok(request); reply(child, request); await flush(); assert.equal(state.status, 'fulfilled'); }
  else { assert.equal(request, undefined); assert.equal(state.status, 'rejected'); }
  assert.equal(child.killed, false);
});
