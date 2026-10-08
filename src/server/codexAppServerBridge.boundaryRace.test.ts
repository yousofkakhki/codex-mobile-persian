// @ts-nocheck
// Exact source routes with synthetic child I/O and memory-only file operations.
import { test } from 'vitest';
import { applyAppServerPermissionDefaults, readAppServerPermissionIntent, readAppServerPermissionDefaults, prepareAppServerHotPermissionOverrides, mergeAppServerHotPermissionOverrides } from './appServerPermissionDefaults';
import { createRequire as makeRequire } from 'node:module';
const require = makeRequire(import.meta.url);
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');const {createRequire}=require('node:module');const ts=createRequire(path.join(process.cwd(),'package.json'))('typescript');const source=fs.readFileSync(path.join(process.cwd(),'src/server/codexAppServerBridge.ts'),'utf8');const originalClass=source.slice(source.indexOf('class AppServerProcess {'),source.indexOf('\nexport class BackendQueueProcessor',source.indexOf('class AppServerProcess {')));const js=ts.transpileModule(originalClass+'\nglobalThis.ExtractedAppServerProcess=AppServerProcess;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
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




function route(pathname, method, context) {
  const begin = source.indexOf(`      if (req.method === '${method}' && url.pathname === '${pathname}') {`);
  const end = source.indexOf('\n      if (', begin + 1);
  assert.ok(begin >= 0 && end > begin, 'exact source route was found');
  vm.runInContext(ts.transpileModule(`globalThis.route = async function(req,res) { const url = { pathname: ${JSON.stringify(pathname)} };` + source.slice(begin, end) + '\n};', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
  return context.route;
}
async function ownedFiles() {
  const f = fixture();
  const child = await healthyInitializedChild(f);
  const acquisition = track(f.app.rpc('thread/resume', { threadId: 'files', excludeTurns: true }));
  await flush();
  reply(child, child.writes.find(r => r.method === 'thread/resume'), { thread: { id: 'files' }, modelProvider: 'openai' });
  await flush();
  assert.equal(acquisition.status, 'fulfilled');
  return { f, child };
}
function expire(f, child, reason) {
  if (reason === 'configuration-deferred') {
    f.changeConfig();
    track(f.app.rpc('config/read', {}));
  } else if (reason === 'thread-closed') {
    child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'thread/closed', params: { threadId: 'files' } }) + '\n');
  } else if (reason === 'quarantine') {
    f.app.timedOutRpcIds.set(999, { method: 'thread/read', params: {} });
  }
}
async function rollbackCase({ reason, boundary = 'history-read', action = 'undo' }) {
  const { f, child } = await ownedFiles();
  let fileWrites = 0;
  let sessionReadStarted = false;
  let resolveSession;
  const session = new Promise(resolve => { resolveSession = resolve; });
  const context = vm.createContext({
    appServer: f.app,
    asRecord: v => v && typeof v === 'object' ? v : null,
    readNonEmptyString: v => typeof v === 'string' ? v.trim() : '',
    readJsonBody: async req => req.payload,
    setJson: (res, status, body) => { res.status = status; res.body = body; },
    getErrorMessage: e => e.message,
    isAbsolute: path.isAbsolute,
    readFile: async () => { sessionReadStarted = true; return boundary === 'session-read' ? session : '{}'; },
    collectFileChangesForTurns: () => new Map([['t', {}]]),
    revertTurnFileChanges: async () => { fileWrites++; return { reverted: 1, errors: [] }; },
    applyTurnFileChanges: async () => { fileWrites++; return { applied: 1, errors: [] }; },
  });
  const rollback = route('/codex-api/thread/rollback-files', 'POST', context);
  const res = {};
  const operation = rollback({ method: 'POST', payload: { threadId: 'files', turnId: 't', cwd: '/in-memory-project', action } }, res);
  await flush();
  const idleRead = child.writes.filter(r => r.method === 'thread/read').at(-1);
  reply(child, idleRead, { thread: { id: 'files', status: { type: 'idle' } } });
  await flush();
  const historyRead = child.writes.filter(r => r.method === 'thread/read').at(-1);
  assert.notEqual(historyRead.id, idleRead.id, 'actual rollback callback history read is pending');
  if (boundary === 'history-read') { expire(f, child, reason); await flush(); }
  reply(child, historyRead, { thread: { id: 'files', status: { type: reason === 'in-progress' ? 'inProgress' : 'idle' }, path: '/in-memory-session.jsonl', turns: [{ id: 't' }] } });
  await flush();
  if (boundary === 'session-read') {
    assert.ok(sessionReadStarted, 'actual asynchronous session log read is pending');
    expire(f, child, reason);
    await flush();
    resolveSession('{}');
  }
  await operation;
  console.log(JSON.stringify({ case: `exact-source-rollback-${reason}-${boundary}-${action}`, response: res.status, fileWrites, childKilled: child.killed, error: res.body?.error }));
  assert.equal(res.status, reason === 'healthy' ? 200 : 409, 'unsafe mutation must fail closed at the exact source file mutation boundary');
  assert.equal(fileWrites, reason === 'healthy' ? 1 : 0, 'unsafe undo/redo must not reach project file writes');
  assert.equal(child.killed, false, 'never kill writer to clear a mutation guard');
}

test.each(['configuration-deferred', 'thread-closed', 'quarantine', 'in-progress'])('P1: rollback callback history await refuses %s at file mutation boundary', async reason => rollbackCase({ reason }));
test.each(['configuration-deferred', 'thread-closed', 'quarantine'])('P1: redo callback session-log await refuses %s at file mutation boundary', async reason => rollbackCase({ reason, boundary: 'session-read', action: 'redo' }));
test.each(['undo', 'redo'])('P1: healthy exact source %s still writes once', async action => rollbackCase({ reason: 'healthy', action }));

function queueFixture(appServer) {
  let stateText = '{}';
  const queueWrites = [];
  const begin = source.indexOf('function normalizeStoredQueuedMessage(');
  const end = source.indexOf('function normalizeReasoningEffort(', begin);
  const queueSource = source.slice(begin, end);
  const context = vm.createContext({
    getCodexGlobalStatePath: () => '/in-memory-only', THREAD_QUEUE_STATE_KEY: 'thread-queue-state',
    readFile: async () => stateText,
    writeFile: async (_p, value) => { stateText = value; queueWrites.push(JSON.parse(value)); },
    normalizeStringArray: v => Array.isArray(v) ? v : [],
    asRecord: v => v && typeof v === 'object' ? v : null,
    readJsonBody: async req => req.payload,
    getErrorMessage: e => e.message,
    setJson: (res, status, body) => { res.status = status; res.body = body; },
    backendQueueProcessor: { scheduleAllQueuedThreads: async () => {} }, appServer,
  });
  vm.runInContext(ts.transpileModule(queueSource + '\nglobalThis.append = appendThreadQueuedMessage;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
  return { context, put: route('/codex-api/thread-queue-state', 'PUT', context), append: context.append, queueWrites, state: () => JSON.parse(stateText) };
}
const queuedMessage = { id: 'q1', text: 'preserve', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' };
test('P1: exact queue PUT cannot omit foreign queue appended before serialized replacement', async () => {
  const f = fixture();
  const q = queueFixture(f.app);
  const res = {};
  const put = q.put({ method: 'PUT', payload: {} }, res);
  const append = q.append('foreign', queuedMessage);
  await Promise.all([put, append]);
  console.log(JSON.stringify({ case: 'same-process-queue-snapshot-race', response: res.status, joinedWriterCount: f.app.joinedThreads.size, queueWrites: q.queueWrites, finalState: q.state() }));
  assert.equal(res.status, 409, 'serialized currentState must include concurrent foreign append and require ownership');
  assert.equal(q.queueWrites.length, 1, 'only authorized append may write state');
  assert.equal(q.state()['thread-queue-state'].foreign[0].text, 'preserve');
});
test('P1: exact queue PUT preserves unchanged foreign queues while replacing owned queues', async () => {
  const { f } = await ownedFiles();
  const q = queueFixture(f.app);
  await q.append('foreign', queuedMessage);
  await q.append('files', { ...queuedMessage, id: 'owned' });
  const res = {};
  await q.put({ method: 'PUT', payload: { foreign: [queuedMessage] } }, res);
  assert.equal(res.status, 200, 'an unchanged foreign queue does not require writer ownership');
  assert.equal(q.state()['thread-queue-state'].foreign[0].text, 'preserve');
  assert.equal(q.state()['thread-queue-state'].files, undefined);
});

test('P1: serialized queue replacement retains writer lease through asynchronous state write', async () => {
  const { f } = await ownedFiles();
  const q = queueFixture(f.app);
  let leaseObserved = false;
  vm.runInContext('globalThis.originalWriteFile = writeFile;', q.context);
  q.context.observeLease = () => { leaseObserved = f.app.fileMutationsByThreadId.has('files'); };
  vm.runInContext('writeFile = async (...args) => { observeLease(); return originalWriteFile(...args); };', q.context);
  const res = {};
  await q.put({ method: 'PUT', payload: { files: [queuedMessage] } }, res);
  assert.equal(res.status, 200);
  assert.equal(leaseObserved, true, 'ownership lease must cover the serialized commit, not only its returned nextState');
  assert.equal(f.app.fileMutationsByThreadId.size, 0, 'commit releases lease after completion');
});
