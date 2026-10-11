import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { assertThreadProjectionIntegrity } from './threadProjectionIntegrity'
import { createCodexProjectionFixture } from './threadProjectionFixture'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import { expect, test } from 'vitest'
import * as permissions from './appServerPermissionDefaults'

// Transpile the exact private class, without editing its body or replacing its
// initialization/transport continuations. Only OS child I/O and fixture config
// are synthetic; no real Codex, provider, customer state, or credentials are used.
const sourcePath = join(process.cwd(), 'src/server/codexAppServerBridge.ts')
const source = readFileSync(sourcePath, 'utf8')
const start = source.indexOf('class AppServerProcess {')
const end = source.indexOf('\nexport class BackendQueueProcessor', start)
if (start < 0 || end <= start) throw new Error('Exact private-class extraction failed')
const classSource = source.slice(start, end)
const ts = createRequire(import.meta.url)('typescript')
const compiled = ts.transpileModule(classSource + '\nglobalThis.PublicationAppServerProcess = AppServerProcess;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
console.log(JSON.stringify({ sourcePath, sourceSha256: createHash('sha256').update(source).digest('hex'),
  classSha256: createHash('sha256').update(classSource).digest('hex'), syntheticTransportOnly: true }))

type Request = { id: number; method: string; params: Record<string, any> }
type Child = EventEmitter & { stdout: EventEmitter & { setEncoding: () => void };
  stderr: EventEmitter & { setEncoding: () => void }; stdin: { write: (line: string) => boolean; end: () => void };
  writes: Request[]; killed: boolean; kill: () => boolean; hook?: (request: Request) => void }
type Timer = { callback: () => void; ms: number; active: boolean; unref: () => void }
type State = { status: string; value?: any; error?: string; code?: number }
type Options = { home?: string; sqliteHome?: string; inspect?: (home: string, id: string, sqliteHome: string) => Promise<void> }
function fixture(options: Options = {}) {
  let revision = 0
  const children: Child[] = [], timers: Timer[] = [], checks: Array<{ threadId: string; sqliteHome: string }> = [], audits: any[] = []
  const sqliteHome = options.sqliteHome ?? '/publication-fixture-sqlite-home'
  const home = options.home ?? '/publication-never-accessed'
  const fakeSpawn = () => {
    const child = new EventEmitter() as Child
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.writes = []; child.killed = false
    child.stdin = { write(line) {
      const request: Request = JSON.parse(line); child.writes.push(request)
      if (request.method === 'config/read' && request.params?.includeLayers === false) queueMicrotask(() => reply(child, request, { config: { sqlite_home: sqliteHome } }))
      else child.hook?.(request)
      return true
    }, end() {} }
    child.kill = () => { child.killed = true; return true }
    children.push(child); return child
  }
  const context = vm.createContext({ ...permissions, Error, spawn: fakeSpawn, queueMicrotask, resolve, join,
    THREAD_RESPONSE_TURN_LIMIT: 10, STREAM_EVENT_BUFFER_LIMIT: 200,
    assertThreadProjectionIntegrity: async (codexHome: string, threadId: string, dbHome: string) => {
      checks.push({ threadId, sqliteHome: dbHome }); await options.inspect?.(codexHome, threadId, dbHome)
    },
    appendGoalBudgetAuditRecord: async (_home: string, record: unknown) => { audits.push(record) },
    asRecord: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : null,
    readNonEmptyString: (value: unknown) => typeof value === 'string' ? value.trim() : '',
    buildAppServerArgs: () => ['app-server', '-c', 'fixture_revision=' + revision],
    getProviderCompatibilityConfigArgs: () => [], getCodexHomeDir: () => home,
    resolveSQLiteHome: () => sqliteHome, FREE_MODE_STATE_FILE: 'fixture-never-read.json',
    ensureDefaultFreeModeStateForMissingAuthSync: () => null,
    getSpawnInvocation: (command: string, args: string[]) => ({ command, args }),
    resolveCodexCommand: () => 'synthetic-not-executed', process: { env: {} },
    setTimeout: (callback: () => void, ms: number) => { const timer = { callback, ms, active: true, unref() {} }; timers.push(timer); return timer },
    clearTimeout: (timer?: Timer) => { if (timer) timer.active = false },
  })
  vm.runInContext(compiled, context)
  const app: any = new context.PublicationAppServerProcess()
  return { app, children, timers, checks, audits, changeConfig: () => { revision++ } }
}
function track(promise: Promise<unknown>): State {
  const state: State = { status: 'pending' }
  promise.then(value => { state.status = 'fulfilled'; state.value = value }, error => { state.status = 'rejected'; state.error = error.message; state.code = error.goalPolicyStatus })
  return state
}
async function flush() { for (let index = 0; index < 64; index++) await Promise.resolve() }
function last(child: Child, method: string): Request {
  const request = child.writes.filter(row => row.method === method).slice(-1)[0]
  if (!request) throw new Error('Synthetic request missing: ' + method)
  return request
}
function reply(child: Child, request: Request, result: unknown = {}) {
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
function notify(child: Child, method: string, params: unknown) {
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}
async function initialized(f: ReturnType<typeof fixture>) {
  const state = track(f.app.rpc('config/read', {})); const child = f.children[0]!
  reply(child, last(child, 'initialize')); await flush()
  reply(child, last(child, 'config/read')); await flush()
  expect(state.status).toBe('fulfilled'); return child
}
const restrictive = { modelProvider: 'fixture-provider', model: 'fixture-model', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false } }
async function acquire(f: ReturnType<typeof fixture>, child: Child, id = 'owned', fields: Record<string, unknown> = { approvalPolicy: 'on-request', sandbox: 'read-only' }) {
  const state = track(f.app.rpc('thread/resume', { threadId: id, excludeTurns: true, ...fields })); await flush()
  reply(child, last(child, 'thread/resume'), { ...restrictive, thread: { id } }); await flush()
  expect(state.status).toBe('fulfilled'); expect(f.app.writerThreadIds.has(id)).toBe(true)
}


import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ActivityStore } from './activityStore'
import { ActivityRecorder } from './activityRecorder'

test('independent PUB-ACT-02: a cold read fulfilled by a retired real bridge generation cannot be rebound to its replacement', async () => {
 const root = await mkdtemp(join(tmpdir(), 'cold-recovery-race-'))
 try {
  const f = fixture(), store = new ActivityStore(root), recorder = new ActivityRecorder(store)
  let changed = false
  const executor = { get process() { return f.app.process }, rpc: (method: string, params: unknown) => {
   return f.app.rpc(method, params).then((value: unknown) => {
    const retired = f.app.process
    retired.emit('exit', 0, null)
    const kick = f.app.rpc('config/read', {})
    void kick.catch(() => {})
    changed = true
    return value
   })
  } }
  const recovering = recorder.recover('owned', executor)
  await expect.poll(() => f.children.length).toBe(1)
  const retired = f.children[0]!
  reply(retired, last(retired, 'initialize')); await flush()
  await expect.poll(() => retired.writes.some(row => row.method === 'thread/items/list')).toBe(true)
  reply(retired, last(retired, 'thread/items/list'), { data: [{ turnId: 'retired-turn', item: { id: 'retired-item', type: 'agentMessage', text: 'PUBLIC RETIRED-GENERATION FIXTURE' } }], nextCursor: null })
  await recovering
  const page = await store.page('owned')
  console.info(JSON.stringify({ probe: 'cold-recovery-success-generation-handoff', changed, children: f.children.length,
    oldEntryCommitted: Boolean(await store.lookup('owned', 'item:retired-item')), recoveryComplete: page.coverage.recoveryComplete }))
  expect(changed).toBe(true); expect(f.children).toHaveLength(2)
  expect(await store.lookup('owned', 'item:retired-item')).toBeNull()
  expect(page.coverage.recoveredHistory).toBe(false)
 } finally { await rm(root, { recursive: true, force: true }) }
})

for (const handoffDepth of [1, 2, 3, 4, 5, 6, 7, 8]) test(`independent PUB-ACT-02: direct cold bridge replacement at microtask depth ${handoffDepth}; old history must not commit`, async () => {
 const root = await mkdtemp(join(tmpdir(), 'direct-cold-recovery-'))
 try {
  const f = fixture(), store = new ActivityStore(root), recorder = new ActivityRecorder(store)
  const recovering = recorder.recover('owned', f.app)
  await expect.poll(() => f.children.length).toBe(1)
  const retired = f.children[0]!
  reply(retired, last(retired, 'initialize')); await flush()
  await expect.poll(() => retired.writes.some(row => row.method === 'thread/items/list')).toBe(true)
  reply(retired, last(retired, 'thread/items/list'), { data: [{ turnId: 'retired-turn', item: { id: 'retired-direct', type: 'agentMessage', text: 'PUBLIC RETIRED DIRECT FIXTURE' } }], nextCursor: null })
  const handoff = (depth: number): void => { queueMicrotask(() => {
   if (depth > 1) { handoff(depth - 1); return }
   retired.emit('exit', 0, null)
   void f.app.rpc('config/read', {}).catch(() => {})
  }) }
  handoff(handoffDepth)
  await recovering
  const page = await store.page('owned')
  console.info(JSON.stringify({ probe: 'direct-cold-recovery-adjacent-microtask', children: f.children.length,
   oldEntryCommitted: Boolean(await store.lookup('owned', 'item:retired-direct')), recoveryComplete: page.coverage.recoveryComplete }))
  expect(f.children).toHaveLength(2)
  expect(await store.lookup('owned', 'item:retired-direct')).toBeNull()
  expect(page.coverage.recoveredHistory).toBe(false)
 } finally { await rm(root, { recursive: true, force: true }) }
})

test('independent cross-area: bridge closure invalidates recovery, reopened acquisition remains protected, deleted store never revives', async () => {
 const root = await mkdtemp(join(tmpdir(), 'bridge-activity-cross-'))
 try {
  const f = fixture(), child = await initialized(f), store = new ActivityStore(root), recorder = new ActivityRecorder(store)
  f.app.setActivityRecorder(recorder)
  await acquire(f, child)
  const recovering = recorder.recover('owned', f.app)
  await expect.poll(() => child.writes.some(row => row.method === 'thread/items/list')).toBe(true)
  const request = last(child, 'thread/items/list')
  notify(child, 'thread/closed', { threadId: 'owned' })
  reply(child, request, { data: [{ turnId: 'old-turn', item: { type: 'agentMessage', id: 'old', text: 'PUBLIC OLD HISTORY' } }], nextCursor: 'older' })
  await recovering; await recorder.flush()
  expect((await store.page('owned')).coverage.recoveredHistory).toBe(false)
  expect(await store.lookup('owned', 'item:old')).toBeNull()
  await acquire(f, child)
  f.app.dispose(); expect(child.killed).toBe(false)
  await recorder.afterRpc('thread/delete', { threadId: 'owned' }, {}, null)
  notify(child, 'item/agentMessage/delta', { threadId: 'owned', itemId: 'late', delta: 'PUBLIC LATE OUTPUT' })
  await recorder.flush()
  expect((await store.page('owned')).entries).toEqual([])
  await expect(readdir(join(root, createHash('sha256').update('owned').digest('hex')))).rejects.toMatchObject({ code: 'ENOENT' })
 } finally { await rm(root, { recursive: true, force: true }) }
})


function failReply(child: Child, request: Request, message: string) {
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message } }) + '\n')
}
for (const warm of [false, true]) for (const fallback of [false, true]) test(`PUB-ACT-02 control: ${warm ? 'warm' : 'cold'} actual bridge ${fallback ? 'unsupported items fallback' : 'items success'} records current-generation history`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'current-activity-control-'))
  try {
    const f = fixture(), store = new ActivityStore(root), recorder = new ActivityRecorder(store)
    const child = warm ? await initialized(f) : null
    const recovery = recorder.recover('owned', f.app)
    await expect.poll(() => f.children.length).toBe(1)
    const active = child ?? f.children[0]!
    if (!warm) { reply(active, last(active, 'initialize')); await flush() }
    await expect.poll(() => active.writes.some(row => row.method === 'thread/items/list')).toBe(true)
    if (fallback) {
      failReply(active, last(active, 'thread/items/list'), 'method not found')
      await expect.poll(() => active.writes.some(row => row.method === 'thread/turns/list')).toBe(true)
      reply(active, last(active, 'thread/turns/list'), { data: [{ id: 'current-turn', items: [{ id: 'current-control', type: 'agentMessage', text: 'PUBLIC CURRENT CONTROL' }], status: 'completed' }], nextCursor: null })
    } else {
      reply(active, last(active, 'thread/items/list'), { data: [{ turnId: 'current-turn', item: { id: 'current-control', type: 'agentMessage', text: 'PUBLIC CURRENT CONTROL' } }], nextCursor: null })
    }
    await recovery
    const page = await store.page('owned')
    expect(await store.lookup('owned', 'item:current-control')).toMatchObject({ reconstructed: true })
    expect((await store.detail('owned', 'item:current-control')).text).toContain('PUBLIC CURRENT CONTROL')
    expect(page.coverage).toMatchObject({ recoveredHistory: true, recoveryComplete: true, warning: null })
    expect(active.writes.filter(row => row.method === 'thread/items/list')).toHaveLength(1)
    expect(active.writes.filter(row => row.method === 'thread/turns/list')).toHaveLength(fallback ? 1 : 0)
    expect(f.children).toHaveLength(1)
    expect(active.killed).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
