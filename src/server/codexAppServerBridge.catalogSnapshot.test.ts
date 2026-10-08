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
  const env = { CODEXUI_MODEL_CATALOG_JSON: '/fixture-catalog' };
  let state = null;
  let catalogRevision = 0;
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
    asRecord: value => value && typeof value === 'object' && !Array.isArray(value) ? value : null,
    readNonEmptyString: value => typeof value === 'string' && value.trim() ? value : '',
    buildAppServerArgs: () => ['app-server', '-c', `fixture_revision=${revision}`],
    getProviderCompatibilityConfigArgs: () => [],
    getCodexHomeDir: () => '/fixture-never-accessed',
    resolveSQLiteHome: () => '/fixture-sqlite-home',
    FREE_MODE_STATE_FILE: 'fixture-state-never-read.json',
    ensureDefaultFreeModeStateForMissingAuthSync: () => state,
    statSync: () => ({ dev: 1, ino: 1, size: 10, mtimeMs: catalogRevision, ctimeMs: catalogRevision }),
    getSpawnInvocation: (command, args) => ({ command, args }),
    resolveCodexCommand: () => 'fake-no-executable-spawned',
    join: path.join,
    process: { env },
    setTimeout: (callback, ms) => { const timer = { callback, ms, active: true, unref: () => {} }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.active = false; },
  });
  vm.runInContext(js, context);
  return { app: new context.ExtractedAppServerProcess(), children, timers, changeConfig: () => { revision += 1; }, env, setState: next => { state = next; }, changeFile: () => { catalogRevision += 1; } };
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






for (const delay of [3, 4, 5, 6, 7]) {
  test(`cold snapshot binds initialized generation before continuation: ${delay} microtasks`, async () => {
    const f = fixture();
    const result = track(f.app.readModelCatalogSnapshot());
    const old = f.children[0];
    reply(old, initializeRequest(old));
    for (let i = 0; i < delay; i++) await Promise.resolve();
    assert.equal(f.app.initialized, true, 'old child completed the real initialize handshake');
    assert.equal(old.writes.filter(row => row.method === 'config/read').length, 0, 'replacement precedes snapshot dispatch');
    f.app.dispose();
    f.app.start();
    await flush();
    const replacement = f.children[1];
    assert.equal(f.app.initialized, false);
    assert.equal(replacement.writes.filter(row => ['config/read', 'model/list'].includes(row.method)).length, 0,
      'metadata may not dispatch into an uninitialized replacement');
    assert.equal(result.status, 'fulfilled');
    assert.equal(result.value, null, 'retired initialization fails closed');
  });
}

for (const condition of ['provider', 'endpoint', 'file', 'quarantine', 'file-mutation', 'deferred', 'generation']) {
  test(`cached snapshot rechecks ${condition} after awaiting, with writer preserved`, async () => {
    const f = fixture();
    f.setState({ provider: 'custom', enabled: true, customBaseUrl: 'http://127.0.0.1:20128/v1', wireApi: 'responses' });
    const child = await healthyInitializedChild(f);
    const warming = track(f.app.readModelCatalogSnapshot());
    await flush();
    reply(child, child.writes.filter(row => row.method === 'config/read').at(-1), { config: { model_catalog_json: '/fixture-catalog' } });
    await flush();
    reply(child, child.writes.find(row => row.method === 'model/list'), { data: [], nextCursor: null });
    await flush();
    assert.equal(warming.status, 'fulfilled');
    f.app.writerThreadIds.add('writer');
    const pending = f.app.readModelCatalogSnapshot();
    if (condition === 'provider') f.setState({ provider: 'codex', enabled: false });
    if (condition === 'endpoint') f.setState({ provider: 'custom', enabled: true, customBaseUrl: 'https://other.example.test/v1', wireApi: 'responses' });
    if (condition === 'file') f.changeFile();
    if (condition === 'quarantine') f.app.timedOutRpcIds.set(99, 'thread/resume');
    if (condition === 'file-mutation') f.app.fileMutationsByThreadId.add('writer');
    if (condition === 'deferred') f.app.configChangeDeferred = true;
    if (condition === 'generation') { f.app.writerThreadIds.clear(); f.app.dispose(); f.app.start(); }
    assert.equal(await pending, null);
    if (condition !== 'generation') { assert.equal(f.children.length, 1); assert.equal(child.killed, false); }
    assert.equal(child.writes.filter(row => row.method === 'model/list').length, 1);
  });
}

test('same proxy config with changed upstream endpoint suppresses runtime Ultra while preserving writer', async () => {
  const f = fixture();
  f.setState({ provider: 'custom', enabled: true, customBaseUrl: 'http://127.0.0.1:20128/v1', wireApi: 'responses' });
  const child = await healthyInitializedChild(f);
  f.app.writerThreadIds.add('writer');
  f.setState({ provider: 'custom', enabled: true, customBaseUrl: 'https://changed.example.test/v1', wireApi: 'responses' });
  assert.equal(await f.app.readModelCatalogSnapshot(), null);
  assert.equal(f.children.length, 1);
  assert.equal(child.killed, false);
  assert.equal(child.writes.filter(row => row.method === 'model/list').length, 0);
});
for (const condition of ['configChangeDeferred', 'timedOutRpcIds', 'fileMutationsByThreadId']) {
  test(`runtime metadata never borrows quarantined or deferred generation: ${condition}`, async () => {
    const f = fixture();
    const child = await healthyInitializedChild(f);
    if (condition === 'configChangeDeferred') f.app.configChangeDeferred = true;
    else if (condition === 'timedOutRpcIds') f.app.timedOutRpcIds.set(99, 'thread/resume');
    else f.app.fileMutationsByThreadId.add('writer');
    assert.equal(await f.app.readModelCatalogSnapshot(), null);
    assert.equal(f.children.length, 1);
    assert.equal(child.killed, false);
    assert.equal(child.writes.filter(row => row.method === 'model/list').length, 0);
  });
}
test('retired generation config reply cannot dispatch model/list into replacement', async () => {
  const f = fixture();
  const child = await healthyInitializedChild(f);
  const result = track(f.app.readModelCatalogSnapshot());
  await flush();
  const config = child.writes.filter(row => row.method === 'config/read').at(-1);
  reply(child, config, { config: { model_catalog_json: '/fixture-catalog' } });
  f.app.dispose();
  f.app.start();
  await flush();
  assert.equal(result.status, 'fulfilled');
  assert.equal(result.value, null);
  assert.equal(f.children[1].writes.filter(row => row.method === 'model/list').length, 0);
});

test('changed catalog at same path cannot borrow old generation model/list', async () => {
  const f = fixture();
  const child = await healthyInitializedChild(f);
  f.app.writerThreadIds.add('writer');
  f.changeFile();
  const result = await f.app.readModelCatalogSnapshot();
  assert.equal(result, null);
  assert.equal(f.children.length, 1);
  assert.equal(child.killed, false);
  assert.equal(child.writes.filter(row => row.method === 'model/list').length, 0);
});

test('no catalog env means no new runtime discovery RPC', async () => {
  const f = fixture();
  const child = await healthyInitializedChild(f);
  delete f.env.CODEXUI_MODEL_CATALOG_JSON;
  const result = await f.app.readModelCatalogSnapshot();
  assert.equal(result, null);
  assert.equal(child.writes.filter(row => row.method === 'config/read').length, 1);
  assert.equal(child.writes.filter(row => row.method === 'model/list').length, 0);
});
test('configuration must confirm the opted-in catalog before model/list', async () => {
  const f = fixture();
  const child = await healthyInitializedChild(f);
  const result = track(f.app.readModelCatalogSnapshot());
  await flush();
  const config = child.writes.filter(row => row.method === 'config/read').at(-1);
  reply(child, config, { config: { model_catalog_json: '/another-file' } });
  await flush();
  assert.equal(result.status, 'fulfilled');
  assert.equal(result.value, null);
  assert.equal(child.writes.filter(row => row.method === 'model/list').length, 0);
});

test('runtime model catalog snapshot never replaces an attached generation and coalesces reads', async () => {
  const f = fixture();
  const child = await healthyInitializedChild(f);
  f.app.joinedThreads.set('writer', {});
  f.app.writerThreadIds.add('writer');
  assert.equal(typeof f.app.readModelCatalogSnapshot, 'function', 'need generation-bound read-only snapshot seam');
  const first = track(f.app.readModelCatalogSnapshot());
  const second = track(f.app.readModelCatalogSnapshot());
  await flush();
  const config = child.writes.filter(row => row.method === 'config/read').at(-1);
  reply(child, config, { config: { model_provider: 'custom_endpoint', model_catalog_json: '/fixture-catalog' } });
  await flush();
  const listing = child.writes.find(row => row.method === 'model/list');
  assert.ok(listing);
  reply(child, listing, { data: [], nextCursor: null });
  await flush();
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'fulfilled');
  assert.equal(first.value, second.value);
  assert.equal(child.writes.filter(row => row.method === 'model/list').length, 1);
  assert.equal(f.children.length, 1);
  assert.equal(child.killed, false);
  const cached = await f.app.readModelCatalogSnapshot();
  assert.equal(cached, first.value);
});
