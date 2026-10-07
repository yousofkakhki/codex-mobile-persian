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
import { test, expect, vi, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { createCodexBridgeMiddleware } from './codexAppServerBridge';
vi.mock('./goalBudgetAudit', async()=>({...await vi.importActual('./goalBudgetAudit'),appendGoalBudgetAuditRecord:vi.fn(async()=>{})}));
afterEach(()=>vi.unstubAllGlobals());
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
    child.stdin = { write: (line) => { const request = JSON.parse(line); child.writes.push(request); if (!options.verifySQLiteHome && request.method === 'config/read' && request.params?.includeLayers === false) queueMicrotask(() => reply(child,request,{config:{sqlite_home:revision ? '/replacement-sqlite-home':'/fixture-sqlite-home'}})); return true; }, end: () => {} };
    child.kill = () => { child.killed = true; return true; };
    child.killed = false;
    children.push(child);
    return child;
  }
  const context = vm.createContext({
    spawn: fakeSpawn,
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

const STOP_SOURCE="async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {\n  const normalizedThreadId = threadId.trim()\n  const normalizedTurnId = turnId?.trim() || ''\n  if (!normalizedThreadId) return\n\n  try {\n    if (!normalizedTurnId) {\n      throw new Error('turn/interrupt requires turnId')\n    }\n    await callRpc('turn/interrupt', { threadId: normalizedThreadId, turnId: normalizedTurnId })\n  } catch (error) {\n    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')\n  }\n}\n\n  async function interruptSelectedThreadTurn(): Promise<void> {\n    const threadId = selectedThreadId.value\n    if (!threadId) return\n    try { assertThreadWritable(threadId) } catch (failure) { error.value = (failure as Error).message; return }\n    if (inProgressById.value[threadId] !== true) return\n    if (interruptBlockedUntilPersistedByThreadId.value[threadId] === true) return\n    let turnId = activeTurnIdByThreadId.value[threadId]\n    if (!turnId) {\n      const { activeTurnId } = await getThreadDetail(threadId)\n      turnId = activeTurnId\n      if (turnId) {\n        activeTurnIdByThreadId.value = {\n          ...activeTurnIdByThreadId.value,\n          [threadId]: turnId,\n        }\n      }\n    }\n    if (!turnId) {\n      throw new Error('Could not determine active turn id for interrupt')\n    }\n\n    isInterruptingTurn.value = true\n    error.value = ''\n    try {\n      await interruptThreadTurn(threadId, turnId)\n      setThreadInProgress(threadId, false)\n      setTurnActivityForThread(threadId, null)\n      setTurnErrorForThread(threadId, null)\n      if (activeTurnIdByThreadId.value[threadId]) {\n        activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)\n      }\n      pendingThreadMessageRefresh.add(threadId)\n      pendingThreadsRefresh = true\n      await syncFromNotifications()\n    } catch (unknownError) {\n      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to interrupt active turn'\n      setTurnErrorForThread(threadId, errorMessage)\n      error.value = errorMessage\n    } finally {\n      isInterruptingTurn.value = false\n    }\n  }\n";

test('CONTROL exact UI Stop caller interrupts active owned thread without bridge Goal/set',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 const interrupts=[];
 const context=vm.createContext({
  callRpc:(method,params)=>{interrupts.push({method,params});return f.app.rpc(method,params);},
  normalizeCodexApiError:error=>error,
  selectedThreadId:{value:'owned'},assertThreadWritable:()=>{},inProgressById:{value:{owned:true}},interruptBlockedUntilPersistedByThreadId:{value:{}},activeTurnIdByThreadId:{value:{owned:'active-turn'}},
  isInterruptingTurn:{value:false},error:{value:''},setThreadInProgress:()=>{},setTurnActivityForThread:()=>{},setTurnErrorForThread:()=>{},omitKey:(v,k)=>Object.fromEntries(Object.entries(v).filter(([id])=>id!==k)),pendingThreadMessageRefresh:new Set(),pendingThreadsRefresh:false,syncFromNotifications:async()=>{},
 });
 vm.runInContext(ts.transpileModule(STOP_SOURCE+'\nglobalThis.runStop=interruptSelectedThreadTurn;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 const result=track(context.runStop());await flush();
 const irq=child.writes.filter(r=>r.method==='turn/interrupt').at(-1);assert.ok(irq);reply(child,irq);await flush();
 assert.equal(result.status,'fulfilled');assert.equal(context.error.value,'');assert.deepEqual(interrupts.map(r=>r.method),['turn/interrupt']);
 console.log('EXACT_STOP',JSON.stringify({status:result.status,methods:interrupts.map(r=>r.method),noPauseRpc:true}));
});
test('REGRESSION stale no-budget existence read cannot recreate a Goal after concurrent clear',async()=>{
 const f=fixture();const child=await healthyInitializedChild(f);await acquire(f,child);
 let stored={threadId:'owned',objective:'Existing',status:'paused',tokenBudget:50,tokensUsed:5,timeUsedSeconds:12,createdAt:1,updatedAt:2};
 let ownerChecks=0;
 vi.stubGlobal('__codexRemoteSharedBridge__',{version:'experimental-api-v2',appServer:f.app,terminalManager:{},methodCatalog:{},telegramBridge:{},backendQueueProcessor:{}});
 // Middleware capture above is created again after fixture registration, so no real shared process can be used.
 const middleware=createCodexBridgeMiddleware({isOwnerAuthorized:()=>{ownerChecks++;return false;}});
 const request=Readable.from([JSON.stringify({method:'thread/goal/set',params:{threadId:'owned',objective:'Recreated without finite budget',status:'active'}})]);request.method='POST';request.url='/codex-api/rpc';request.headers={};
 let output='';const response=new Writable({write(c,e,d){output+=c.toString();d();}});response.setHeader=()=>{};
 const result=track(middleware(request,response,()=>{throw new Error('next');}));
 await flush();await new Promise(resolve=>setImmediate(resolve));await flush();
 const get=child.writes.filter(r=>r.method==='thread/goal/get').at(-1);console.log('COMBINED_INITIAL',JSON.stringify({status:result.status,error:result.error,writes:child.writes,output}));assert.ok(get);
 const clearState=track(f.app.rpc('thread/goal/clear',{threadId:'owned'}));await flush();
 assert.equal(clearState.status,'rejected','concurrent sameGoal clear is rejected before native dispatch');
 assert.equal(child.writes.filter(r=>r.method==='thread/goal/clear').length,0);
 reply(child,get,{goal:{...stored}});await flush();
 const read=child.writes.filter(r=>r.method==='thread/read').at(-1);assert.ok(read);
 reply(child,read,{thread:{id:'owned',status:{type:'idle'}}});await flush();
 const set=child.writes.filter(r=>r.method==='thread/goal/set').at(-1);
 if(set){stored={...stored,...set.params};reply(child,set,{goal:stored});await flush();}
 reply(child,child.writes.filter(r=>r.method==='thread/goal/get').at(-1),{goal:stored});await flush();assert.equal(result.status,'fulfilled');assert.equal(response.statusCode,200);
 console.log('IMPLICIT_RECREATE',JSON.stringify({httpStatus:response.statusCode,ownerChecks,dispatch:set??null,stored}));
 assert.equal(child.writes.filter(r=>r.method==='thread/goal/set').length,1,'existing Goal remains owned; clear was rejected, so edit cannot implicitly create');
});
