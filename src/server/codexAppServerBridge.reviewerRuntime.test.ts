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

function note(name, extra) { console.log('INDEPENDENT_SEAM',JSON.stringify({name,...extra})); }
test('REGRESSION existing Goal editor status-only pause is supported on active owned writer',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 child.stdout.emit('data',JSON.stringify({method:'turn/started',params:{threadId:'owned',turn:{id:'active-turn'}}})+'\n');
 const state=track(f.app.rpc('thread/goal/set',{threadId:'owned',status:'paused'}));await flush();
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);if(read){reply(child,read,{thread:{id:'owned',status:{type:'inProgress'}}});await flush();}
 const request=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);
 note('active-pause',{status:state.status,error:state.error,pauseDispatches:child.writes.filter(r=>r.method==='thread/goal/set').length,killed:child.killed});
 assert.ok(request,'Existing Goal editor pause must reach an active owned writer');reply(child,request,{goal:{threadId:'owned',status:'paused'}});await flush();assert.equal(state.status,'fulfilled');
});
test('CONTROL active owned direct interrupt succeeds without idle read',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 child.stdout.emit('data',JSON.stringify({method:'turn/started',params:{threadId:'owned',turn:{id:'active-turn'}}})+'\n');
 const state=track(f.app.rpc('turn/interrupt',{threadId:'owned',turnId:'active-turn'}));await flush();
 const request=child.writes.filter(r=>r.method==='turn/interrupt').at(-1);assert.ok(request);reply(child,request);await flush();assert.equal(state.status,'fulfilled');assert.equal(child.killed,false);
});
test.each(['thread/goal/set','thread/goal/clear','thread/rollback','turn/interrupt'])('ADVERSARIAL %s rejects writer loss after SQLite read',async method=>{
 const opts={};const f=fixture(opts);const child=await healthyInitializedChild(f);await acquire(f,child);opts.verifySQLiteHome=true;f.app.confirmedSQLiteHome='';
 const state=track(f.app.rpc(method,method==='thread/goal/set'?{threadId:'owned',status:'paused'}:method==='thread/goal/clear'?{threadId:'owned'}:{threadId:'owned',status:'paused',turnId:'active-turn'}));await flush();
 const request=child.writes.filter(r=>r.method==='config/read').at(-1);assert.ok(request);reply(child,request,{config:{sqlite_home:'/fixture-sqlite-home'}});f.app.writerThreadIds.delete('owned');await flush();
 assert.equal(child.writes.filter(r=>r.method===method).length,0);assert.equal(state.status,'rejected');assert.equal(child.killed,false);
});
test.each(['thread/goal/set','thread/goal/clear','thread/rollback','turn/interrupt'])('ADVERSARIAL %s requires both joined and retained writer evidence',async method=>{
 const f=fixture();const child=await healthyInitializedChild(f);f.app.joinedThreads.set('owned',{});
 const state=track(f.app.rpc(method,method==='thread/goal/set'?{threadId:'owned',status:'paused'}:method==='thread/goal/clear'?{threadId:'owned'}:{threadId:'owned',status:'paused',turnId:'active-turn'}));await flush();assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method===method).length,0);
});
test.each(['thread/goal/set','thread/goal/clear','thread/rollback'])('ADVERSARIAL %s cannot use wrong-target idle read',async method=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const state=track(f.app.rpc(method,method==='thread/goal/clear'?{threadId:'owned'}:{threadId:'owned',status:'paused'}));await flush();reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'foreign',status:{type:'idle'}}});await flush();assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method===method).length,0);
});
test.each(['thread/goal/set','thread/goal/clear','thread/rollback'])('ADVERSARIAL %s rejects new turn even if completed before idle response',async method=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const state=track(f.app.rpc(method,method==='thread/goal/clear'?{threadId:'owned'}:{threadId:'owned',status:'paused'}));await flush();
 for(const method of ['turn/started','turn/completed'])child.stdout.emit('data',JSON.stringify({method,params:{threadId:'owned',turn:{id:'racing-turn'}}})+'\n');
 reply(child,child.writes.filter(r=>r.method==='thread/read').at(-1),{thread:{id:'owned',status:{type:'idle'}}});await flush();assert.equal(state.status,'rejected');assert.equal(child.writes.filter(r=>r.method===method).length,0);
});
