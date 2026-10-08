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
function fixture() {
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
    child.stdin = { write: (line) => { child.writes.push(JSON.parse(line)); return true; }, end: () => {} };
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
    buildAppServerArgs: () => ['app-server', '-c', `fixture_revision=${revision}`],
    getProviderCompatibilityConfigArgs: () => [],
    getCodexHomeDir: () => '/fixture-never-accessed',
    resolveSQLiteHome: () => '/fixture-sqlite-home',
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
  return { app: new context.ExtractedAppServerProcess(), children, timers, changeConfig: () => { revision += 1; } };
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

test('REGRESSION: stalled initialization is bounded and disposes only its child', async () => {
  const f = fixture();
  const result = track(f.app.rpc('thread/list', {}));
  assert.ok(f.timers.some(timer => timer.active && timer.ms <= 30000), 'initialize must have a deadline');
  f.timers.find(timer => timer.active).callback();
  await flush();
  assert.equal(result.status, 'rejected');
  assert.match(result.error, /timed out/);
  assert.equal(f.app.pending.size, 0);
  assert.equal(f.app.process, null);
});
test('REGRESSION: stalled RPC cleans up pending entry without retrying a side effect', async () => {
  const f = fixture();
  const child = await healthyInitializedChild(f);
  const result = track(f.app.rpc('turn/start', {}));
  await flush();
  const timer = f.timers.find(timer => timer.active && timer.ms <= 120000);
  assert.ok(timer, 'RPC must have a deadline');
  timer.callback();
  await flush();
  assert.equal(result.status, 'rejected');
  assert.match(result.error, /timed out/);
  assert.equal(f.app.pending.size, 0);
  assert.equal(child.writes.filter(row => row.method === 'turn/start').length, 1);
  f.app.dispose();
});
test('CONTROL: clean config replacement allows config/read to complete', async () => {
  const f = fixture();
  await healthyInitializedChild(f);
  f.changeConfig();
  const state = track(f.app.rpc('config/read', {}));
  const child = f.children[1];
  reply(child, initializeRequest(child));
  await flush();
  const request = child.writes.find((item) => item.method === 'config/read');
  assert.ok(request);
  reply(child, request);
  await flush();
  assert.equal(state.status, 'fulfilled');
  console.log(JSON.stringify({ case: 'clean-replacement-control', status: state.status }));
  f.app.dispose();
});

test('REGRESSION: retired child stdout must not corrupt replacement initialize response', async () => {
  const f = fixture();
  const retired = await healthyInitializedChild(f);
  f.changeConfig();
  const state = track(f.app.rpc('thread/list', {}));
  const replacement = f.children[1];
  const init = initializeRequest(replacement);
  const response = JSON.stringify({ jsonrpc: '2.0', id: init.id, result: {} }) + '\n';
  const split = response.indexOf(',') + 1;
  replacement.stdout.emit('data', response.slice(0, split));
  retired.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'fixture/retired-notification', params: {} }) + '\n');
  replacement.stdout.emit('data', response.slice(split));
  await flush();
  const request = replacement.writes.find((item) => item.method === 'thread/list');
  if (request) { reply(replacement, request, { data: [] }); await flush(); }
  console.log(JSON.stringify({ case: 'retired-stdout-corruption', status: state.status, replacementInitializeId: init.id, pendingIds: [...f.app.pending.keys()], initialized: f.app.initialized, initializePromisePresent: f.app.initializePromise !== null, replacementMethods: replacement.writes.map((item) => item.method) }));
  try { assert.equal(state.status, 'fulfilled', 'retired stdout consumed and discarded the valid replacement initialize reply; RPC remains pending'); }
  finally { f.app.dispose(); await flush(); }
});

test('REGRESSION: retired initialize.finally must not clear replacement initializePromise', async () => {
  const f = fixture();
  const oldState = track(f.app.rpc('config/read', {}));
  f.changeConfig();
  const currentState = track(f.app.rpc('thread/list', {}));
  const replacement = f.children[1];
  await flush();
  const promisePresent = f.app.initializePromise !== null;
  const thirdState = track(f.app.rpc('config/read', {}));
  const initializeCount = replacement.writes.filter((item) => item.method === 'initialize').length;
  console.log(JSON.stringify({ case: 'retired-finally-clobber', retiredStatus: oldState.status, currentStatus: currentState.status, thirdStatus: thirdState.status, initializePromisePresentBeforeThirdRPC: promisePresent, replacementInitializeCount: initializeCount }));
  try { assert.equal(promisePresent, true, 'retired initialize.finally cleared a newer initializePromise'); }
  finally { f.app.dispose(); await flush(); }
});

test('REGRESSION: retired initialize.then must not initialize or notify replacement child', async () => {
  const f = fixture();
  const oldState = track(f.app.rpc('thread/list', {}));
  const retired = f.children[0];
  reply(retired, initializeRequest(retired));
  // Deliberately replace the child before the fulfilled initialization continuation runs.
  f.changeConfig();
  const currentState = track(f.app.rpc('config/read', {}));
  const replacement = f.children[1];
  await flush();
  console.log(JSON.stringify({ case: 'retired-then-cross-generation', retiredStatus: oldState.status, currentStatus: currentState.status, replacementInitializeResponseDelivered: false, initialized: f.app.initialized, initializePromisePresent: f.app.initializePromise !== null, replacementMethods: replacement.writes.map((item) => item.method) }));
  try { assert.equal(f.app.initialized, false, 'retired initialization marked a replacement child initialized before its handshake response'); }
  finally { f.app.dispose(); await flush(); }
});

test('REGRESSION: RPC resumed after replacement must not bypass replacement handshake', async () => {
  const f = fixture();
  await healthyInitializedChild(f);
  const earlierState = track(f.app.rpc('thread/list', {}));
  // rpc() yielded at await ensureInitialized() while the previous child was ready.
  f.changeConfig();
  const currentState = track(f.app.rpc('config/read', {}));
  const replacement = f.children[1];
  await flush();
  const prematureMethods = replacement.writes.filter((item) => item.method !== 'initialize').map((item) => item.method);
  console.log(JSON.stringify({ case: 'rpc-await-cross-generation', earlierStatus: earlierState.status, currentStatus: currentState.status, replacementInitializeResponseDelivered: false, replacementMethods: replacement.writes.map((item) => item.method) }));
  try { assert.deepEqual(prematureMethods, [], 'rpc() sent its method to a replacement child without waiting for that child initialization'); }
  finally { f.app.dispose(); await flush(); }
});
