import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'

const api = vi.hoisted(() => Object.fromEntries([
  'archiveThread', 'forkThread', 'getAccountRateLimits', 'getAvailableCollaborationModes', 'getAvailableModelIds', 'getCurrentModelConfig',
  'getPendingServerRequests', 'getSkillsList', 'getThreadDetail', 'getOlderThreadMessages', 'getThreadGroupsPage', 'getThreadQueueState', 'getThreadSummary',
  'getThreadTitleCache', 'getWorkspaceRootsState', 'generateThreadTitle', 'interruptThreadTurn', 'persistThreadTitle', 'renameThread',
  'replyToServerRequest', 'resumeThread', 'invalidateThreadResumeCache', 'revertThreadFileChanges', 'rollbackThread', 'setThreadSpeedMode',
  'setThreadQueueState', 'setWorkspaceRootsState', 'startThread', 'startThreadTurn', 'subscribeCodexNotifications',
  'getThreadGoal', 'setThreadGoal', 'clearThreadGoal',
].map(name => [name, vi.fn()])))
vi.mock('../api/codexGateway', () => ({ ...api, getBackgroundThreadListLimit: () => 100, pickCodexRateLimitSnapshot: () => null }))
const config = { model: 'fixture-model', providerId: 'custom_endpoint', reasoningEffort: 'medium', speedMode: 'standard' }
const detail = () => ({ model: 'fixture-model', modelProvider: 'custom_endpoint', messages: [], inProgress: false,
  activeTurnId: '', hasMoreOlder: false, olderCursor: null, turnIndexByTurnId: {}, speedMode: 'standard' })
const refresh = { includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true, providerChanged: true }
const forked = { threadId: 'private-fork', cwd: '/fixture', model: 'fixture-model', modelProvider: 'custom_endpoint', messages: [] }
type ForkKind = 'summary' | 'turn'
const fork = (state: ReturnType<typeof useDesktopState>, kind: ForkKind, id: string) => kind === 'summary' ? state.forkThreadById(id) : state.forkThreadFromTurn(id, 0)

beforeEach(() => {
  vi.resetAllMocks()
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setTimeout: vi.fn(), clearTimeout: vi.fn() })
  api.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
  api.getWorkspaceRootsState.mockRejectedValue(new Error('private roots unavailable'))
  api.getThreadTitleCache.mockResolvedValue({ titles: {} }); api.getThreadQueueState.mockResolvedValue({})
  api.setThreadQueueState.mockResolvedValue(undefined)
  api.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
  api.getAccountRateLimits.mockResolvedValue(null); api.getSkillsList.mockResolvedValue([])
  api.getCurrentModelConfig.mockResolvedValue(config); api.getAvailableModelIds.mockResolvedValue(['fixture-model'])
  api.resumeThread.mockResolvedValue(detail()); api.getThreadDetail.mockResolvedValue(detail())
  api.startThread.mockResolvedValue({ threadId: 'private-new-thread', model: 'fixture-model', modelProvider: 'custom_endpoint' })
  api.startThreadTurn.mockResolvedValue('synthetic-turn'); api.getThreadGoal.mockResolvedValue(null)
  api.forkThread.mockResolvedValue(forked)
})
afterEach(() => vi.unstubAllGlobals())

async function realForkTransport() {
  const gateway = await vi.importActual<typeof import('../api/codexGateway')>('../api/codexGateway')
  gateway.invalidateThreadResumeCache()
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)); requests.push(request)
    return new Response(JSON.stringify({ result: {
      thread: { id: forked.threadId, cwd: '/fixture', turns: [] }, model: 'fixture-model', modelProvider: 'custom_endpoint',
    } }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  api.forkThread.mockImplementation((...args: [string, string?, string?]) => args.length === 1
    ? gateway.forkThread(args[0]) : gateway.forkThread(args[0], args[1], args[2]))
  return { gateway, requests }
}

describe('PUB-ROUTE-01-REMAINING-FORK-PREFLIGHT actual desktop acquisition paths', () => {
  it.each(['summary', 'turn'] as const)('suspends %s fork helper before acquisition during deferred config refresh', async kind => {
    const state = useDesktopState(); state.primeSelectedThread('source')
    await state.refreshAll(refresh); await state.loadMessages('source')
    let finish!: (value: typeof config) => void
    api.getCurrentModelConfig.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const refreshing = state.refreshAll(refresh)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const result = await fork(state, kind, 'source')
    finish(config); await refreshing
    expect(result).toBe('')
    expect(api.forkThread).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('source')
    expect(api.startThreadTurn).not.toHaveBeenCalled()
    expect(api.rollbackThread).not.toHaveBeenCalled()
  })
  it.each(['summary', 'turn'] as const)('sends no real gateway RPC for %s fork during deferred config refresh', async kind => {
    const state = useDesktopState(); state.primeSelectedThread('source')
    await state.refreshAll(refresh); await state.loadMessages('source')
    const { requests } = await realForkTransport()
    let finish!: (value: typeof config) => void
    api.getCurrentModelConfig.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const refreshing = state.refreshAll(refresh)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const result = await fork(state, kind, 'source')
    finish(config); await refreshing
    expect(result).toBe('')
    expect(requests).toEqual([])
    expect(api.forkThread).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('source')
  })
  it.each(['summary', 'turn'] as const)('keeps one captured revision through an in-flight %s fork; no adoption, retry, or reacquisition', async kind => {
    const state = useDesktopState(); state.primeSelectedThread('source')
    await state.refreshAll(refresh); await state.loadMessages('source')
    const { requests } = await realForkTransport()
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Promise<Response>(resolve => { finish = resolve })
    }))
    const pending = fork(state, kind, 'source')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await state.refreshAll(refresh)
    finish(new Response(JSON.stringify({ result: { thread: { id: 'obsolete-fork', cwd: '/fixture', turns: [] }, model: 'fixture-model', modelProvider: 'custom_endpoint' } }), { status: 200 }))
    expect(await pending).toBe('')
    expect(requests.map(request => request.method)).toEqual(['thread/fork'])
    expect(api.forkThread).toHaveBeenCalledTimes(1)
    expect(state.selectedThreadId.value).toBe('source')
    expect(state.projectGroups.value.flatMap(group => group.threads).some(thread => thread.id === 'obsolete-fork')).toBe(false)
    expect(api.rollbackThread).not.toHaveBeenCalled(); expect(api.renameThread).not.toHaveBeenCalled()
    expect(api.startThreadTurn).not.toHaveBeenCalled()
  })
  it('retains the turn-fork entry revision across uncached history acquisition even after a replacement catalog settles', async () => {
    const state = useDesktopState(); state.primeSelectedThread('source')
    await state.refreshAll(refresh)
    let finish!: (value: ReturnType<typeof detail>) => void
    api.resumeThread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = state.forkThreadFromTurn('source', 0)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await state.refreshAll(refresh)
    finish(detail())
    expect(await pending).toBe('')
    expect(api.forkThread).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('source')
  })
  it.each(['summary', 'turn'] as const)('allows one legitimate settled-catalog %s fork and its next user-started turn', async kind => {
    const state = useDesktopState(); state.primeSelectedThread('source')
    await state.refreshAll(refresh); await state.loadMessages('source')
    const { requests } = await realForkTransport()
    const configReads = api.getCurrentModelConfig.mock.calls.length
    const catalogReads = api.getAvailableModelIds.mock.calls.length
    const start = performance.now()
    expect(await fork(state, kind, 'source')).toBe('private-fork')
    const forkElapsedMs = performance.now() - start
    expect(api.forkThread).toHaveBeenCalledTimes(1)
    expect(requests.map(request => request.method)).toEqual(['thread/fork'])
    expect(requests[0]?.params.threadId).toBe('source')
    if (kind === 'turn') expect(requests[0]?.params.persistExtendedHistory).toBe(true)
    expect(state.selectedThreadId.value).toBe('private-fork')
    await state.sendMessageToSelectedThread('private synthetic next user turn')
    expect(api.startThreadTurn).toHaveBeenCalledTimes(1)
    expect(api.getCurrentModelConfig).toHaveBeenCalledTimes(configReads)
    expect(api.getAvailableModelIds).toHaveBeenCalledTimes(catalogReads)
    console.info('publicationCycle2 settled fork measurement', JSON.stringify({ kind, forkRequests: requests.length, additionalConfigReads: 0, additionalCatalogReads: 0, nextTurnRequests: api.startThreadTurn.mock.calls.length, forkElapsedMs }))
  })
})
