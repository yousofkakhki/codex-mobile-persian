import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'
import type { ZenModelMetadata } from '../types/zenModels'

const api = vi.hoisted(() => Object.fromEntries([
  'archiveThread','forkThread','getAccountRateLimits','getAvailableCollaborationModes','getAvailableModelIds','getCurrentModelConfig',
  'getPendingServerRequests','getSkillsList','getThreadDetail','getOlderThreadMessages','getThreadGroupsPage','getThreadQueueState','getThreadSummary',
  'getThreadTitleCache','getWorkspaceRootsState','generateThreadTitle','interruptThreadTurn','persistThreadTitle','renameThread',
  'replyToServerRequest','resumeThread','invalidateThreadResumeCache','revertThreadFileChanges','rollbackThread','setThreadSpeedMode',
  'setThreadQueueState','setWorkspaceRootsState','startThread','startThreadTurn','subscribeCodexNotifications',
  'getThreadGoal','setThreadGoal','clearThreadGoal',
].map(name => [name, vi.fn()])))
vi.mock('../api/codexGateway', () => ({ ...api, getBackgroundThreadListLimit: () => 100, pickCodexRateLimitSnapshot: () => null }))
const detail = (provider = 'custom_endpoint') => ({ model: 'fixture-model', modelProvider: provider, messages: [], inProgress: false,
  activeTurnId: '', hasMoreOlder: false, olderCursor: null, turnIndexByTurnId: {}, speedMode: 'standard' })
const refresh = { includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true, providerChanged: true }
beforeEach(() => {
  vi.resetAllMocks()
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setTimeout: vi.fn(), clearTimeout: vi.fn() })
  api.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
  api.getWorkspaceRootsState.mockRejectedValue(new Error('private roots unavailable'))
  api.getThreadTitleCache.mockResolvedValue({ titles: {} }); api.getThreadQueueState.mockResolvedValue({})
  api.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
  api.getAccountRateLimits.mockResolvedValue(null); api.getSkillsList.mockResolvedValue([])
  api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId: 'custom_endpoint', reasoningEffort: 'medium', speedMode: 'standard' })
  api.getAvailableModelIds.mockResolvedValue(['fixture-model'])
  api.resumeThread.mockResolvedValue(detail()); api.getThreadDetail.mockResolvedValue(detail())
  api.startThread.mockResolvedValue({ threadId: 'new-fixture', model: 'fixture-model', modelProvider: 'custom_endpoint' })
  api.startThreadTurn.mockResolvedValue('synthetic-turn-not-native')
  api.getThreadGoal.mockResolvedValue(null)
})
afterEach(() => vi.unstubAllGlobals())

// Seams/schedules adapted privately from immutable reviewCarriedOrdering witnesses.
// Read-only paging/fanout observations are retained as unchanged behavior, not
// used as positive publication-safety evidence for these four blocker fixes.
describe('publicationCycle1 unchanged adjacent paging observation', () => {
  it('preserves earlier-before-latest item order without changing duplicate item reconciliation', async () => {
    const state = useDesktopState(); state.primeSelectedThread('paging-fixture')
    await state.refreshAll(refresh)
    api.resumeThread.mockResolvedValue({ ...detail(), hasMoreOlder: true, olderCursor: 'older', turnIndexByTurnId: { t: 0 }, messages: [{ id: 'newest', role: 'assistant', text: 'latest', turnId: 't', turnIndex: 0 }] })
    await state.loadMessages('paging-fixture')
    api.getOlderThreadMessages.mockResolvedValue({ messages: [{ id: 'earlier', role: 'user', text: 'earlier', turnId: 't', turnIndex: 0 }, { id: 'newest', role: 'assistant', text: 'latest complete', turnId: 't', turnIndex: 0 }], turnIndexByTurnId: { t: 0 }, hasMoreOlder: false, nextCursor: null, inProgress: false, activeTurnId: '' })
    await state.loadOlderMessages('paging-fixture')
    expect(state.messages.value.map(message => message.id)).toEqual(['earlier', 'newest'])
    expect(state.messages.value.find(message => message.id === 'newest')?.text).toBe('latest')
  })
})
describe('PUB-GOAL-02 accepted literal message routing', () => {
  it.each(['/goal', '/goal pause', '/goal resume', '/goal clear', '/goal SYNTHETIC_OBJECTIVE'])(
    'sends literal %s on a selected thread without local Goal RPCs', async text => {
      const state = useDesktopState(); state.primeSelectedThread('literal-goal-fixture')
      await state.refreshAll(refresh)
      await state.sendMessageToSelectedThread(text)
      expect(api.startThreadTurn).toHaveBeenCalledWith('literal-goal-fixture', text, [], 'fixture-model', 'medium', undefined, [], 'default', 'standard')
      expect(api.getThreadGoal).not.toHaveBeenCalled()
      expect(api.setThreadGoal).not.toHaveBeenCalled()
      expect(api.clearThreadGoal).not.toHaveBeenCalled()
    })
  it.each(['/goal', '/goal pause', '/goal resume', '/goal clear', '/goal SYNTHETIC_OBJECTIVE'])(
    'creates a normal nonempty turn for new-thread literal %s', async text => {
      const state = useDesktopState(); state.primeSelectedThread('')
      await state.refreshAll(refresh)
      await expect(state.sendMessageToNewThread(text, '/fixture')).resolves.toBe('new-fixture')
      await vi.waitFor(() => expect(api.startThreadTurn).toHaveBeenCalledTimes(1))
      expect(api.startThreadTurn.mock.calls[0]?.[1]).toBe(text)
      expect(state.messages.value.some(message => message.role === 'user' && message.text === text)).toBe(true)
      expect(api.getThreadGoal).not.toHaveBeenCalled()
      expect(api.setThreadGoal).not.toHaveBeenCalled()
      expect(api.clearThreadGoal).not.toHaveBeenCalled()
    })
  it('keeps attached skill/file/image resources on the literal normal-turn path', async () => {
    const state = useDesktopState(); state.primeSelectedThread('literal-resource-fixture')
    await state.refreshAll(refresh)
    const skills = [{ name: 'fixture-skill', path: '/fixture/SKILL.md' }]
    const files = [{ label: 'fixture.txt', path: 'fixture.txt', fsPath: '/fixture/fixture.txt' }]
    await state.sendMessageToSelectedThread('/goal private objective', ['fixture-image'], skills, 'steer', files)
    expect(api.startThreadTurn).toHaveBeenCalledWith('literal-resource-fixture', '/goal private objective', ['fixture-image'], 'fixture-model', 'medium', skills, files, 'default', 'standard')
    expect(api.setThreadGoal).not.toHaveBeenCalled()
    expect(api.getThreadGoal).not.toHaveBeenCalled()
  })
})

describe('PUB-PROVIDER-01 authoritative provider identity', () => {
  it('keeps distinct arbitrary-provider model slots when switching A/B/A', async () => {
    api.getAvailableModelIds.mockResolvedValue(['fixture-model', 'model-a', 'model-b'])
    api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId: 'Case_Gateway', reasoningEffort: 'medium', speedMode: 'standard' })
    const state = useDesktopState(); state.primeSelectedThread('')
    await state.refreshAll(refresh); state.setSelectedModelId('model-a')
    api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId: 'case-gateway', reasoningEffort: 'medium', speedMode: 'standard' })
    await state.refreshAll(refresh); state.setSelectedModelId('model-b')
    api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId: 'Case_Gateway', reasoningEffort: 'medium', speedMode: 'standard' })
    await state.refreshAll(refresh)
    expect(state.selectedModelId.value).toBe('model-a')
    const slots = JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')
    expect(slots['__new-thread-provider__::Case_Gateway']).toBe('model-a')
    expect(slots['__new-thread-provider__::case-gateway']).toBe('model-b')
  })


  it.each(['Case_Gateway', 'case-gateway', 'CASE_gateway', 'another_Gateway'])(
    'preserves arbitrary configured wire ID throughout discovery and resume: %s', async providerId => {
      api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId, reasoningEffort: 'medium', speedMode: 'standard' })
      api.resumeThread.mockResolvedValue(detail(providerId))
      const state = useDesktopState(); state.primeSelectedThread('provider-fixture')
      await state.refreshAll(refresh)
      expect(api.getAvailableModelIds).toHaveBeenCalledWith(expect.objectContaining({ providerId }))
      await state.sendMessageToSelectedThread('private-only-mocked-payload')
      expect(api.resumeThread).toHaveBeenCalledWith('provider-fixture', expect.objectContaining({ modelProvider: providerId }))
      expect(api.startThreadTurn).toHaveBeenCalledTimes(1)
    })
  it.each(['case-gateway', 'case_gateway', 'CASE_Gateway'])(
    'does not accept a colliding returned provider as Case_Gateway: %s', async returned => {
      api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId: 'Case_Gateway', reasoningEffort: 'medium', speedMode: 'standard' })
      api.resumeThread.mockResolvedValue(detail(returned))
      const state = useDesktopState(); state.primeSelectedThread('provider-collision')
      await state.refreshAll(refresh)
      await expect(state.sendMessageToSelectedThread('private-only-mocked-payload')).rejects.toThrow(/different provider/)
      expect(api.startThreadTurn).not.toHaveBeenCalled()
    })
  it.each(['custom', 'CUSTOM', 'custom-endpoint', 'custom_endpoint'])(
    'keeps enumerated custom alias compatibility: %s', async providerId => {
      api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId, reasoningEffort: 'medium', speedMode: 'standard' })
      const state = useDesktopState(); state.primeSelectedThread('provider-alias')
      await state.refreshAll(refresh)
      expect(api.getAvailableModelIds).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'custom-endpoint' }))
      await state.sendMessageToSelectedThread('private-only-mocked-payload')
      expect(api.startThreadTurn).toHaveBeenCalledTimes(1)
    })
})

describe('PUB-ULTRA-01 actual desktop guard', () => {
  it('rejects unaudited Astra Ultra when IDs-only discovery has no affirmative metadata', async () => {
    api.getCurrentModelConfig.mockResolvedValue({ model: 'cx/gpt-6-astra-unreviewed-suffix', providerId: 'custom_endpoint', reasoningEffort: 'high', speedMode: 'standard' })
    api.getAvailableModelIds.mockResolvedValue(['cx/gpt-6-astra-unreviewed-suffix'])
    const state = useDesktopState(); state.primeSelectedThread('ultra-fixture')
    await state.refreshAll(refresh)
    state.setSelectedReasoningEffort('ultra')
    expect(state.selectedReasoningEffort.value).toBe('high')
  })
})

describe('PUB-ROUTE-01 acquisition ordering', () => {
  it.each([true, false])('loads uncached selected history only after a successful deferred catalog refresh (awaitAncillary=%s)', async awaitAncillaryRefreshes => {
    const history = { ...detail(), messages: [{ id: 'fresh-history', role: 'assistant', text: 'preserved history' }] }
    api.resumeThread.mockResolvedValue(history)
    let finishCatalog!: (ids: string[]) => void
    api.getAvailableModelIds.mockImplementationOnce(() => new Promise<string[]>(resolve => { finishCatalog = resolve }))
    const state = useDesktopState(); state.primeSelectedThread('refresh-history-fixture')
    const refreshing = state.refreshAll({ providerChanged: true, awaitAncillaryRefreshes })
    await vi.waitFor(() => expect(finishCatalog).toBeTypeOf('function'))
    expect(api.resumeThread).not.toHaveBeenCalled()
    expect(api.startThreadTurn).not.toHaveBeenCalled()
    finishCatalog(['fixture-model'])
    await refreshing
    expect(api.resumeThread).toHaveBeenCalledTimes(1)
    expect(api.resumeThread).toHaveBeenCalledWith('refresh-history-fixture', expect.objectContaining({ modelProvider: 'custom-endpoint', model: 'fixture-model' }))
    expect(api.getAvailableModelIds).toHaveBeenCalledTimes(1)
    expect(state.messages.value.map(message => message.text)).toEqual(['preserved history'])
    expect(state.error.value).toBe('')
  })
  it('does not acquire uncached selected history after a failed catalog refresh', async () => {
    api.getAvailableModelIds.mockRejectedValueOnce(new Error('private failed catalog'))
    const state = useDesktopState(); state.primeSelectedThread('refresh-history-failed')
    await state.refreshAll({ providerChanged: true, awaitAncillaryRefreshes: true })
    expect(api.resumeThread).not.toHaveBeenCalled()
    expect(api.startThreadTurn).not.toHaveBeenCalled()
    expect(state.error.value).toBe('private failed catalog')
  })
  it('does not reuse a history acquisition even when A/B/A restores the same exact provider string', async () => {
    api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId: 'Case_Gateway', reasoningEffort: 'medium', speedMode: 'standard' })
    api.resumeThread.mockResolvedValue(detail('Case_Gateway'))
    const state = useDesktopState(); state.primeSelectedThread('route-aba')
    await state.refreshAll(refresh)
    let finish!: (value: ReturnType<typeof detail>) => void
    api.resumeThread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const loading = state.loadMessages('route-aba')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId: 'case-gateway', reasoningEffort: 'medium', speedMode: 'standard' })
    await state.refreshAll(refresh)
    api.getCurrentModelConfig.mockResolvedValue({ model: 'fixture-model', providerId: 'Case_Gateway', reasoningEffort: 'medium', speedMode: 'standard' })
    await state.refreshAll(refresh)
    finish(detail('Case_Gateway')); await loading
    await state.sendMessageToSelectedThread('private-only-mocked-payload')
    expect(api.resumeThread).toHaveBeenCalledTimes(2)
    expect(api.resumeThread).toHaveBeenLastCalledWith('route-aba', expect.objectContaining({ modelProvider: 'Case_Gateway' }))
    expect(api.startThreadTurn).toHaveBeenCalledTimes(1)
  })

  it('does not replay notification fallback after routing invalidation overtakes its acquisition continuation', async () => {
    api.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-original', providerId: 'openai', reasoningEffort: 'medium', speedMode: 'standard' })
    api.getAvailableModelIds.mockResolvedValue(['gpt-original', 'gpt-5.4-mini'])
    api.resumeThread.mockResolvedValue({ ...detail('openai'), model: 'gpt-original' })
    api.getPendingServerRequests.mockResolvedValue([])
    api.getThreadGroupsPage.mockResolvedValue({ groups: [{ id: '/fixture', name: 'Fixture', cwd: '/fixture', threads: [{ id: 'fallback-fixture', title: 'Fixture', cwd: '/fixture', projectName: 'Fixture', createdAtIso: '2026-10-11T00:00:00Z', updatedAtIso: '2026-10-11T00:00:00Z', preview: '', unread: false, inProgress: false }] }], nextCursor: null })
    api.rollbackThread.mockImplementationOnce(async () => {
      // Same adjacent continuation race as normal send, now through the other
      // async acquisition caller triggered by a native turn error notification.
      queueMicrotask(() => queueMicrotask(() => { void state.refreshAll(refresh) }))
      return []
    })
    let notify!: (notification: { method: string; params: unknown; atIso: string }) => void
    api.subscribeCodexNotifications.mockImplementation(callback => { notify = callback; return vi.fn() })
    const state = useDesktopState(); state.primeSelectedThread('fallback-fixture')
    await state.refreshAll(refresh)
    state.startPolling()
    let finishTurn!: (id: string) => void
    api.startThreadTurn.mockImplementationOnce(() => new Promise<string>(resolve => { finishTurn = resolve }))
    const sending = state.sendMessageToSelectedThread('private-only-mocked-payload')
    await vi.waitFor(() => expect(finishTurn).toBeTypeOf('function'))
    notify({ method: 'turn/started', params: { threadId: 'fallback-fixture', turn: { id: 'synthetic-turn-not-native' } }, atIso: '2026-10-11T00:00:00Z' })
    notify({ method: 'error', params: { threadId: 'fallback-fixture', error: { message: 'model is not supported when using Codex with a ChatGPT account' }, willRetry: false }, atIso: '2026-10-11T00:00:00Z' })
    expect(state.error.value, 'notification error must be seen before retry').toContain('model is not supported')
    expect(state.availableModelIds.value).toContain('gpt-5.4-mini')
    expect(api.getAvailableModelIds.mock.calls.at(-1)?.[0]).toMatchObject({ providerId: undefined })
    await vi.waitFor(() => expect(api.rollbackThread).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(api.invalidateThreadResumeCache).toHaveBeenCalledTimes(2))
    expect(api.startThreadTurn).toHaveBeenCalledTimes(1)
    expect(state.error.value).toMatch(/changed|refreshing/)
    finishTurn('synthetic-turn-not-native')
    await sending
  })

  it.each(['summary', 'turn'] as const)('does not promote stale %s fork acquisition', async kind => {
    const state = useDesktopState(); state.primeSelectedThread('fork-source')
    await state.refreshAll(refresh)
    let finish!: (value: unknown) => void
    api.forkThread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const forking = kind === 'summary' ? state.forkThreadById('fork-source') : state.forkThreadFromTurn('fork-source', 0)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await state.refreshAll(refresh)
    finish({ threadId: 'stale-fork', cwd: '/fixture', model: 'fixture-model', modelProvider: 'custom_endpoint', messages: [] })
    expect(await forking).toBe('')
    expect(state.selectedThreadId.value).toBe('fork-source')
    expect(api.startThreadTurn).not.toHaveBeenCalled()
  })

  it('never promotes a stale history resume; a subsequent send reacquires current routing', async () => {
    const state = useDesktopState(); state.primeSelectedThread('history-fixture')
    await state.refreshAll(refresh)
    let finish!: (value: ReturnType<typeof detail>) => void
    api.resumeThread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const loading = state.loadMessages('history-fixture')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await state.refreshAll(refresh)
    finish(detail()); await loading
    await state.sendMessageToSelectedThread('private-only-mocked-payload')
    expect(api.invalidateThreadResumeCache).toHaveBeenCalledTimes(2)
    expect(api.resumeThread).toHaveBeenCalledTimes(2)
    expect(api.resumeThread.mock.invocationCallOrder.at(-1)).toBeLessThan(api.startThreadTurn.mock.invocationCallOrder[0]!)
    expect(api.startThreadTurn).toHaveBeenCalledTimes(1)
  })
  it('rejects stale new-thread acquisition before selection, readiness or turn dispatch', async () => {
    const state = useDesktopState(); state.primeSelectedThread('')
    await state.refreshAll(refresh)
    let finish!: (value: unknown) => void
    api.startThread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const creating = state.sendMessageToNewThread('private-only-mocked-payload', '/fixture').then(() => null, (error: unknown) => error)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await state.refreshAll(refresh)
    finish({ threadId: 'stale-fixture', model: 'fixture-model', modelProvider: 'custom_endpoint' })
    expect(await creating).toBeInstanceOf(Error)
    expect(state.selectedThreadId.value).toBe('')
    expect(api.startThreadTurn).not.toHaveBeenCalled()
    expect(api.resumeThread).not.toHaveBeenCalled()
    await expect(state.sendMessageToNewThread('fresh acquisition', '/fixture')).resolves.toBe('new-fixture')
    await vi.waitFor(() => expect(api.startThreadTurn).toHaveBeenCalledTimes(1))
  })
  it('does not dispatch after invalidation in the ready-resume continuation microtask', async () => {
    const state = useDesktopState(); state.primeSelectedThread('continuation-fixture')
    await state.refreshAll(refresh)
    api.resumeThread.mockImplementationOnce(async () => {
      // ensureGlobalProviderForTurn resumes first; this nested microtask overtakes
      // startTurnForThread after the readiness check has already returned.
      queueMicrotask(() => queueMicrotask(() => { void state.refreshAll(refresh) }))
      return detail()
    })
    const sending = state.sendMessageToSelectedThread('private-only-mocked-payload').then(() => null, (error: unknown) => error)
    expect(await sending).toBeInstanceOf(Error)
    expect(api.startThreadTurn).not.toHaveBeenCalled()
  })
  it('rejects history acquired during deferred config instead of retaining a legacy ready writer', async () => {
    const state = useDesktopState(); state.primeSelectedThread('deferred-history')
    await state.refreshAll(refresh)
    let finishConfig!: (value: unknown) => void
    api.getCurrentModelConfig.mockImplementationOnce(() => new Promise(resolve => { finishConfig = resolve }))
    const refreshing = state.refreshAll(refresh)
    await vi.waitFor(() => expect(finishConfig).toBeTypeOf('function'))
    const loading = state.loadMessages('deferred-history').then(() => null, (error: unknown) => error)
    expect(await loading).toBeInstanceOf(Error)
    expect(api.resumeThread).not.toHaveBeenCalled()
    finishConfig({ model: 'fixture-model', providerId: 'custom_endpoint', reasoningEffort: 'medium', speedMode: 'standard' })
    await refreshing
    await state.sendMessageToSelectedThread('fresh current route')
    expect(api.resumeThread).toHaveBeenCalledTimes(1)
    expect(api.startThreadTurn).toHaveBeenCalledTimes(1)
  })
})
