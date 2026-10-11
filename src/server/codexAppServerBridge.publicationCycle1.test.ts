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
  const context = vm.createContext({ ...permissions, spawn: fakeSpawn, queueMicrotask, resolve, join,
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

test('PUB-SRV-01: fresh initialized generation rebases retired closure epoch and preserves its acknowledged writer', async () => {
  const f = fixture(), retired = await initialized(f); await acquire(f, retired)
  notify(retired, 'thread/closed', { threadId: 'owned' }); retired.emit('exit', 0, null)
  const resumed = track(f.app.rpc('thread/resume', { threadId: 'owned', excludeTurns: true })); await flush()
  const fresh = f.children[1]!
  reply(fresh, last(fresh, 'initialize')); await flush()
  const request = last(fresh, 'thread/resume')
  expect(f.app.permissionRequestsById.get(request.id).generation).toBe(fresh)
  expect(f.app.permissionRequestsById.get(request.id).epoch).toBe(0)
  reply(fresh, request, { ...restrictive, thread: { id: 'owned', status: { type: 'active', activeFlags: [] } } }); await flush()
  expect(resumed.status).toBe('fulfilled'); expect(f.app.writerThreadIds.has('owned')).toBe(true)
  f.app.dispose(); expect(fresh.killed).toBe(false)
})

test('PUB-SRV-01: caller identity rejection cannot discard the actual successful native writer', async () => {
  const f = fixture(), child = await initialized(f)
  const resumed = track(f.app.rpc('thread/resume', { threadId: 'requested', excludeTurns: true })); await flush()
  reply(child, last(child, 'thread/resume'), { ...restrictive, thread: { id: 'actual-native-id', status: { type: 'active', activeFlags: [] } } }); await flush()
  expect(resumed.status).toBe('rejected'); expect(f.app.joinedThreads.has('requested')).toBe(false)
  expect(f.app.permissionIntentByThreadId.has('actual-native-id')).toBe(false)
  expect(f.app.writerThreadIds.has('actual-native-id')).toBe(true)
  f.app.dispose(); expect(child.killed).toBe(false)
})

for (const dimension of ['both', 'approvalPolicy', 'sandbox']) {
  test(`PUB-SRV-02: unsubscribe ACK then omitted hot rejoin preserves ${dimension} intent until completed close`, async () => {
    const f = fixture(), child = await initialized(f)
    const fields = dimension === 'both' ? { approvalPolicy: 'on-request', sandbox: 'read-only' }
      : dimension === 'approvalPolicy' ? { approvalPolicy: 'on-request' } : { sandbox: 'read-only' }
    await acquire(f, child, 'owned', fields)
    const retained = { ...f.app.permissionIntentByThreadId.get('owned') }
    const unsubscribe = track(f.app.rpc('thread/unsubscribe', { threadId: 'owned' })); await flush()
    reply(child, last(child, 'thread/unsubscribe')); await flush()
    expect(unsubscribe.status).toBe('fulfilled'); expect(f.app.joinedThreads.has('owned')).toBe(false)
    expect(f.app.writerThreadIds.has('owned')).toBe(true)
    const beforeRejoin = child.writes.length
    const rejoin = track(f.app.rpc('thread/resume', { threadId: 'owned', excludeTurns: true })); await flush()
    // Dispatch at the actual request seam; the frozen bug sends resume, while a
    // correct writer-lifetime hot rejoin uses read without acquiring a new writer.
    const dispatched = child.writes.slice(beforeRejoin).filter(row => ['thread/resume', 'thread/read'].includes(row.method))[0]!
    reply(child, dispatched, { ...restrictive, thread: { id: 'owned', status: { type: 'active', activeFlags: [] } } }); await flush()
    expect(rejoin.status).toBe('fulfilled')
    expect(f.app.permissionIntentByThreadId.get('owned')).toEqual(retained)
    expect(dispatched.method).toBe('thread/read')
    expect(child.writes.filter(row => row.method === 'thread/resume')).toHaveLength(1)
    expect(rejoin.value.modelProvider).toBe(restrictive.modelProvider)
    // Viewing alone must not manufacture a native subscription/mutation permit.
    expect(f.app.joinedThreads.has('owned')).toBe(false)
    const turn = track(f.app.rpc('turn/start', { threadId: 'owned', input: [] })); await flush()
    const next = last(child, 'turn/start')
    if (retained.approvalPolicy) expect(Object.prototype.hasOwnProperty.call(next.params, 'approvalPolicy')).toBe(false)
    else expect(next.params.approvalPolicy).toBe('never')
    if (retained.sandbox) expect(Object.prototype.hasOwnProperty.call(next.params, 'sandboxPolicy')).toBe(false)
    else expect(next.params.sandboxPolicy.type).toBe('dangerFullAccess')
    reply(child, next); await flush(); expect(turn.status).toBe('fulfilled')
    f.changeConfig(); f.app.dispose(); expect(child.killed).toBe(false)
    notify(child, 'thread/closed', { threadId: 'owned' })
    expect(f.app.permissionIntentByThreadId.has('owned')).toBe(false)
    expect(f.app.pendingHotPermissionsByThreadId.has('owned')).toBe(false)
    expect(f.app.writerThreadIds.has('owned')).toBe(false)
  })
}

test('PUB-SRV-03: nested identity and unsupported page fields never override the inspected outer thread', async () => {
  const home = createCodexProjectionFixture({ offset: 99999 })
  try {
    const inspect = async (codexHome: string, id: string, sqliteHome: string) => assertThreadProjectionIntegrity(codexHome, id, sqliteHome)
    const f = fixture({ home, sqliteHome: home, inspect }), child = await initialized(f)
    // "owned" has no projection; "fixture" has a genuine unsafe checkpoint.
    const acquisition = track(f.app.rpc('thread/resume', { threadId: 'owned', excludeTurns: true, approvalPolicy: 'on-request', sandbox: 'read-only' }))
    await expect.poll(() => child.writes.some(row => row.method === 'thread/resume')).toBe(true)
    reply(child, last(child, 'thread/resume'), { ...restrictive, thread: { id: 'owned' } }); await flush()
    expect(acquisition.status).toBe('fulfilled'); f.checks.length = 0
    const hot = track(f.app.rpc('thread/resume', { threadId: 'owned', excludeTurns: true,
      initialTurnsPage: { threadId: 'fixture', cursor: 'not-in-initial-page-contract', includeTurns: true, limit: 500, sortDirection: 'desc', itemsView: 'full' } }))
    await expect.poll(() => child.writes.some(row => row.method === 'thread/read')).toBe(true)
    reply(child, last(child, 'thread/read'), { thread: { id: 'owned', status: { type: 'idle' } } })
    await expect.poll(() => child.writes.some(row => row.method === 'thread/turns/list')).toBe(true)
    const page = last(child, 'thread/turns/list')
    expect(page.params).toEqual({ threadId: 'owned', limit: 10, sortDirection: 'desc', itemsView: 'full' })
    expect(f.checks).toEqual([{ threadId: 'owned', sqliteHome: home }, { threadId: 'owned', sqliteHome: home }])
    reply(child, page, { data: [{ id: 'outer-page' }], nextCursor: 'older' }); await flush()
    expect(hot.status).toBe('fulfilled'); expect(hot.value.thread.id).toBe('owned')
    expect(hot.value.initialTurnsPage.nextCursor).toBe('older')
    // The same real integrity boundary rejects direct reads of unsafe fixture;
    // neither DB nor rollout changes, and the owned writer remains protected.
    const paths = ['state_5.sqlite', 'thread_history_1.sqlite', 'fixture.jsonl']
    const digest = () => paths.map(p => createHash('sha256').update(readFileSync(join(home, p))).digest('hex'))
    const before = digest(), requests = child.writes.length
    const unsafe = track(f.app.rpc('thread/turns/list', { threadId: 'fixture', limit: 10 }))
    await expect.poll(() => unsafe.status).toBe('rejected')
    expect(unsafe.error).toMatch(/history integrity mismatch/)
    expect(child.writes.length).toBe(requests); expect(digest()).toEqual(before)
    f.app.dispose(); expect(child.killed).toBe(false)
  } finally { await rm(home, { recursive: true, force: true }) }
})

for (const hot of [false, true]) {
  test(`PUB-SRV-03: ${hot ? 'hot' : 'cold'} initial page forwards only pinned V2 page fields`, async () => {
    const f = fixture(), child = await initialized(f)
    if (hot) await acquire(f, child)
    const state = track(f.app.rpc('thread/resume', { threadId: 'owned', excludeTurns: true,
      initialTurnsPage: { threadId: 'foreign', limit: 500, sortDirection: 'asc', itemsView: 'summary', cursor: 'unexpected', arbitrary: 'not-native' } }))
    await flush()
    if (hot) {
      reply(child, last(child, 'thread/read'), { thread: { id: 'owned' } }); await flush()
      const request = last(child, 'thread/turns/list')
      expect(request.params).toEqual({ limit: 10, sortDirection: 'asc', itemsView: 'summary', threadId: 'owned' })
      reply(child, request, { data: [], nextCursor: null })
    } else {
      const request = last(child, 'thread/resume')
      expect(request.params.initialTurnsPage).toEqual({ limit: 10, sortDirection: 'asc', itemsView: 'summary' })
      reply(child, request, { ...restrictive, thread: { id: 'owned' }, initialTurnsPage: { data: [], nextCursor: null } })
    }
    await flush(); expect(state.status).toBe('fulfilled')
  })
}

const activeGoal = { threadId: 'owned', objective: 'Preserved objective', status: 'active', tokenBudget: 100,
  tokensUsed: 5, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 }
function serveGoal(child: Child, status: string, update: (goal: Record<string, any>, request: Request) => Record<string, any> = (goal, request) => ({ ...goal, ...request.params, updatedAt: 3 })) {
  let goal: Record<string, any> = { ...activeGoal }
  child.hook = request => {
    let result: unknown
    if (request.method === 'thread/goal/get') result = { goal: { ...goal } }
    else if (request.method === 'thread/read') result = { thread: { id: 'owned', status: { type: status, activeFlags: [] } } }
    else if (request.method === 'thread/goal/set') { goal = update(goal, request); result = { goal: { ...goal } } }
    else if (request.method === 'thread/goal/clear') { goal = {}; result = {} }
    else throw new Error('Unexpected Goal fixture method: ' + request.method)
    queueMicrotask(() => reply(child, request, result))
  }
  return () => goal
}
for (const entry of ['rpc', 'rpcInner', 'scoped', 'editor']) {
  test(`PUB-GOAL-01: V2 active status permits only an owned status-only pause through ${entry}`, async () => {
    const f = fixture(), child = await initialized(f); await acquire(f, child)
    const readGoal = serveGoal(child, 'active')
    const params = { threadId: 'owned', status: 'paused', ...(entry === 'editor' ? { objective: activeGoal.objective, ownerConfirmed: true } : {}) }
    const paused = track(entry === 'scoped' ? f.app.withThreadGoalMutation('owned', (rpc: any) => rpc('thread/goal/set', params))
      : f.app[entry === 'editor' ? 'rpc' : entry]('thread/goal/set', params))
    await flush()
    expect(paused.status).toBe('fulfilled')
    expect(child.writes.filter(row => row.method === 'thread/goal/set')).toHaveLength(1)
    expect(last(child, 'thread/goal/set').params).toEqual({ threadId: 'owned', status: 'paused' })
    expect(readGoal()).toEqual({ ...activeGoal, status: 'paused', updatedAt: 3 })
    expect(f.app.goalMutationsByThreadId.size).toBe(0); expect(f.audits).toEqual([])
    f.app.dispose(); expect(child.killed).toBe(false)
  })
}
for (const edit of [{ objective: 'Changed', status: 'paused' }, { tokenBudget: 200, status: 'paused', ownerConfirmed: true },
  { status: 'active' }, { status: 'complete' }, { clear: true }]) {
  test(`PUB-GOAL-01: V2 active denies other mutations ${JSON.stringify(edit)} despite owner authority`, async () => {
    const f = fixture(), child = await initialized(f); await acquire(f, child)
    const readGoal = serveGoal(child, 'active')
    const params = edit.clear ? { threadId: 'owned' } : { threadId: 'owned', ...edit }
    const state = track(f.app.mutateGoal(edit.clear ? 'thread/goal/clear' : 'thread/goal/set', params, { ownerAuthorized: true })); await flush()
    expect(state.status).toBe('rejected'); expect(readGoal()).toEqual(activeGoal)
    expect(child.writes.filter(row => ['thread/goal/set', 'thread/goal/clear'].includes(row.method))).toHaveLength(0)
    expect(f.app.goalMutationsByThreadId.size).toBe(0); expect(f.audits).toEqual([])
  })
}

test('PUB-GOAL-01: V2 active status-only pause accepts nondecreasing concurrent native usage without reset', async () => {
  const f = fixture(), child = await initialized(f); await acquire(f, child)
  const readGoal = serveGoal(child, 'active', (goal, request) => ({ ...goal, ...request.params, tokensUsed: 8, timeUsedSeconds: 13, updatedAt: 3 }))
  const state = track(f.app.rpc('thread/goal/set', { threadId: 'owned', status: 'paused' })); await flush()
  expect(state.status).toBe('fulfilled')
  expect(last(child, 'thread/goal/set').params).toEqual({ threadId: 'owned', status: 'paused' })
  expect(readGoal()).toEqual({ ...activeGoal, status: 'paused', tokensUsed: 8, timeUsedSeconds: 13, updatedAt: 3 })
  expect(child.writes.filter(row => row.method === 'thread/goal/set')).toHaveLength(1)
  expect(f.app.goalMutationsByThreadId.size).toBe(0); expect(f.audits).toEqual([])
})

for (const result of [{ tokensUsed: 4 }, { timeUsedSeconds: 11 }, { objective: 'Unexpected replacement' }, { tokenBudget: null }, { createdAt: 3 }]) {
  test(`PUB-GOAL-01: active pause rejects violated durable invariant ${JSON.stringify(result)} without retry or repair`, async () => {
    const f = fixture(), child = await initialized(f); await acquire(f, child)
    serveGoal(child, 'active', (goal, request) => ({ ...goal, ...request.params, ...result, updatedAt: 3 }))
    const state = track(f.app.rpc('thread/goal/set', { threadId: 'owned', status: 'paused' })); await flush()
    expect(state.status).toBe('rejected'); expect(state.code).toBe(502)
    expect(child.writes.filter(row => row.method === 'thread/goal/set')).toHaveLength(1)
    expect(child.writes.filter(row => row.method === 'thread/goal/clear')).toHaveLength(0)
    expect(f.app.goalMutationsByThreadId.size).toBe(0); expect(f.audits).toEqual([])
  })
}

test('PUB-GOAL-01: active pause holds its lease until authoritative post-read despite competing turn and clear', async () => {
  const f = fixture(), child = await initialized(f); await acquire(f, child)
  const paused = track(f.app.rpc('thread/goal/set', { threadId: 'owned', status: 'paused' })); await flush()
  reply(child, last(child, 'thread/goal/get'), { goal: activeGoal }); await flush()
  reply(child, last(child, 'thread/read'), { thread: { id: 'owned', status: { type: 'active', activeFlags: [] } } }); await flush()
  reply(child, last(child, 'thread/goal/set'), { goal: { ...activeGoal, status: 'paused' } }); await flush()
  const post = last(child, 'thread/goal/get'); expect(paused.status).toBe('pending')
  expect(f.app.goalMutationsByThreadId.size).toBe(1)
  const turn = track(f.app.rpc('turn/start', { threadId: 'owned', input: [] }))
  const clear = track(f.app.rpc('thread/goal/clear', { threadId: 'owned' })); await flush()
  expect(turn.status).toBe('rejected'); expect(clear.status).toBe('rejected')
  expect(child.writes.filter(row => ['turn/start', 'thread/goal/clear'].includes(row.method))).toHaveLength(0)
  reply(child, post, { goal: { ...activeGoal, status: 'paused', tokensUsed: 8, timeUsedSeconds: 13, updatedAt: 3 } }); await flush()
  expect(paused.status).toBe('fulfilled'); expect(f.app.goalMutationsByThreadId.size).toBe(0)
})

for (const edit of [{ status: 'paused' }, { objective: 'Idle edit' }]) {
  test(`PUB-GOAL-01: idle mutation ${JSON.stringify(edit)} still requires exact accounting preservation`, async () => {
    const f = fixture(), child = await initialized(f); await acquire(f, child)
    serveGoal(child, 'idle', (goal, request) => ({ ...goal, ...request.params, tokensUsed: 8, updatedAt: 3 }))
    const state = track(f.app.rpc('thread/goal/set', { threadId: 'owned', ...edit })); await flush()
    expect(state.status).toBe('rejected'); expect(state.code).toBe(502)
    expect(child.writes.filter(row => row.method === 'thread/goal/set')).toHaveLength(1)
    expect(f.app.goalMutationsByThreadId.size).toBe(0)
  })
}

for (const method of ['thread/start', 'thread/resume']) {
  for (const ordering of ['ack then close', 'close then ack', 'timeout then late ack']) {
    test(`PUB-SRV-01: actual-ID/epoch ${method} ${ordering} never disposes an acknowledged unclosed writer`, async () => {
      const f = fixture(), child = await initialized(f)
      const id = 'actual-' + method
      const state = track(f.app.rpc(method, method === 'thread/start' ? {} : { threadId: id, excludeTurns: true })); await flush()
      const request = last(child, method)
      if (ordering === 'timeout then late ack') {
        const timer = f.timers.filter(row => row.active && row.ms === 120000).slice(-1)[0]!
        timer.callback(); await flush(); expect(state.status).toBe('rejected')
      }
      const ack = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ...restrictive, thread: { id, status: { type: 'active', activeFlags: [] } } } }) + '\n'
      const close = JSON.stringify({ jsonrpc: '2.0', method: 'thread/closed', params: { threadId: id } }) + '\n'
      child.stdout.emit('data', ordering === 'ack then close' ? ack + close : ordering === 'close then ack' ? close + ack : ack)
      await flush(); f.app.dispose()
      if (ordering === 'ack then close') {
        expect(state.status).toBe('rejected'); expect(f.app.writerThreadIds.has(id)).toBe(false)
        expect(f.app.permissionIntentByThreadId.has(id)).toBe(false)
        expect(f.app.joinedThreads.has(id)).toBe(false)
      } else {
        expect(f.app.writerThreadIds.has(id)).toBe(true); expect(child.killed).toBe(false)
        if (ordering === 'close then ack' && method === 'thread/resume') {
          expect(state.status).toBe('rejected'); expect(f.app.permissionIntentByThreadId.has(id)).toBe(false)
          expect(f.app.joinedThreads.has(id)).toBe(false)
        }
        notify(child, 'thread/closed', { threadId: id }); expect(f.app.writerThreadIds.has(id)).toBe(false)
      }
    })
  }
}

for (const boundary of ['summary', 'page preflight', 'page']) {
  test(`PUB-SRV-02/03: unsubscribed retained writer closes during ${boundary} without stale staging or reacquisition`, async () => {
    const options: Options = {}, f = fixture(options), child = await initialized(f); await acquire(f, child)
    const unsub = track(f.app.rpc('thread/unsubscribe', { threadId: 'owned' })); await flush()
    reply(child, last(child, 'thread/unsubscribe')); await flush(); expect(unsub.status).toBe('fulfilled')
    let inspections = 0, release: (() => void) | undefined
    if (boundary === 'page preflight') options.inspect = async () => {
      if (++inspections === 2) await new Promise<void>(resolve => { release = resolve })
    }
    const hot = track(f.app.rpc('thread/resume', { threadId: 'owned', excludeTurns: true,
      approvalPolicy: 'never', sandbox: 'danger-full-access', initialTurnsPage: { limit: 10 } })); await flush()
    if (boundary === 'summary') notify(child, 'thread/closed', { threadId: 'owned' })
    reply(child, last(child, 'thread/read'), { thread: { id: 'owned' } }); await flush()
    if (boundary === 'page preflight') {
      expect(release).toBeTypeOf('function'); notify(child, 'thread/closed', { threadId: 'owned' }); release!(); await flush()
    }
    if (boundary === 'page') {
      notify(child, 'thread/closed', { threadId: 'owned' }); reply(child, last(child, 'thread/turns/list'), { data: [] }); await flush()
    }
    expect(hot.status).toBe('rejected'); expect(f.app.pendingHotPermissionsByThreadId.has('owned')).toBe(false)
    expect(f.app.permissionIntentByThreadId.has('owned')).toBe(false); expect(f.app.writerThreadIds.has('owned')).toBe(false)
    expect(child.writes.filter(row => row.method === 'thread/resume')).toHaveLength(1)
    if (boundary === 'page preflight') expect(child.writes.filter(row => row.method === 'thread/turns/list')).toHaveLength(0)
  })
}

for (const dimension of ['approvalPolicy', 'sandbox']) {
  test(`PUB-SRV-02: accepted newer ${dimension} restriction supersedes staged access on an unsubscribed retained writer`, async () => {
    const f = fixture(), child = await initialized(f); await acquire(f, child)
    const unsub = track(f.app.rpc('thread/unsubscribe', { threadId: 'owned' })); await flush()
    reply(child, last(child, 'thread/unsubscribe')); await flush(); expect(unsub.status).toBe('fulfilled')
    const hot = track(f.app.rpc('thread/resume', { threadId: 'owned', excludeTurns: true,
      ...(dimension === 'approvalPolicy' ? { approvalPolicy: 'never' } : { sandbox: 'danger-full-access' }) })); await flush()
    reply(child, last(child, 'thread/read'), { thread: { id: 'owned' } }); await flush(); expect(hot.status).toBe('fulfilled')
    const restricted = track(f.app.rpc('turn/start', { threadId: 'owned', input: [],
      ...(dimension === 'approvalPolicy' ? { approvalPolicy: 'on-request' } : { sandboxPolicy: { type: 'readOnly', networkAccess: false } }) })); await flush()
    reply(child, last(child, 'turn/start')); await flush(); expect(restricted.status).toBe('fulfilled')
    expect(f.app.pendingHotPermissionsByThreadId.has('owned')).toBe(false)
    expect(f.app.permissionIntentByThreadId.get('owned')[dimension]).toBe(true)
    const omitted = track(f.app.rpc('turn/start', { threadId: 'owned', input: [] })); await flush()
    const next = last(child, 'turn/start')
    expect(Object.prototype.hasOwnProperty.call(next.params, dimension === 'sandbox' ? 'sandboxPolicy' : dimension)).toBe(false)
    reply(child, next); await flush(); expect(omitted.status).toBe('fulfilled')
    expect(f.app.joinedThreads.has('owned')).toBe(false); f.app.dispose(); expect(child.killed).toBe(false)
  })
}
