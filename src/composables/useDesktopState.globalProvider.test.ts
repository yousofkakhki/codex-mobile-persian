import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'

const gatewayMocks = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  forkThread: vi.fn(),
  getAccountRateLimits: vi.fn(),
  getAvailableCollaborationModes: vi.fn(),
  getAvailableModelIds: vi.fn(),
  getCurrentModelConfig: vi.fn(),
  getPendingServerRequests: vi.fn(),
  getSkillsList: vi.fn(),
  getThreadDetail: vi.fn(),
  getThreadGroupsPage: vi.fn(),
  getThreadQueueState: vi.fn(),
  getThreadSummary: vi.fn(),
  getThreadTitleCache: vi.fn(),
  getWorkspaceRootsState: vi.fn(),
  generateThreadTitle: vi.fn(),
  interruptThreadTurn: vi.fn(),
  persistThreadTitle: vi.fn(),
  renameThread: vi.fn(),
  replyToServerRequest: vi.fn(),
  resumeThread: vi.fn(),
  invalidateThreadResumeCache: vi.fn(),
  revertThreadFileChanges: vi.fn(),
  rollbackThread: vi.fn(),
  setCodexSpeedMode: vi.fn(),
  setThreadQueueState: vi.fn(),
  setWorkspaceRootsState: vi.fn(),
  startThread: vi.fn(),
  startThreadTurn: vi.fn(),
  subscribeCodexNotifications: vi.fn(),
}))

vi.mock('../api/codexGateway', () => ({
  ...gatewayMocks,
  getBackgroundThreadListLimit: vi.fn(() => 100),
  pickCodexRateLimitSnapshot: vi.fn(() => null),
}))


function installWindow(storage: Record<string, string> = {}) {
  const store = new Map(Object.entries(storage))
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  }, setTimeout: vi.fn(), clearTimeout: vi.fn() })
}
function detail(modelProvider = 'openai', model = 'gpt-5.4-mini') {
  return { model, modelProvider, messages: [], inProgress: false, activeTurnId: '', hasMoreOlder: false, olderCursor: null, turnIndexByTurnId: {} }
}
beforeEach(() => {
  vi.resetAllMocks()
  installWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
  gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('fixture roots unavailable'))
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
  gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
  gatewayMocks.getSkillsList.mockResolvedValue([])
  gatewayMocks.resumeThread.mockResolvedValue(detail())
  gatewayMocks.getThreadDetail.mockResolvedValue(detail())
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'Ggh', providerId: 'custom_endpoint', reasoningEffort: '', speedMode: 'standard' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['cx/gpt-6.1-sol', 'provider-other'])
  gatewayMocks.startThreadTurn.mockResolvedValue('fixture-turn')
})
afterEach(() => vi.unstubAllGlobals())
const refresh = { includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true, providerChanged: true }

describe('global provider consistency', () => {
it('blocks queue persistence before changing an in-progress read-only thread', async()=>{
 gatewayMocks.setThreadQueueState.mockResolvedValue(undefined);
 const state=useDesktopState();
 gatewayMocks.resumeThread.mockResolvedValue({...detail(),readOnly:true,inProgress:true,activeTurnId:'owned-turn'});
 state.primeSelectedThread('readonly-queue'); await state.loadMessages('readonly-queue');
 await expect(state.sendMessageToSelectedThread('must not queue',[],[],'queue')).rejects.toThrow(/read-only/);
 expect(gatewayMocks.setThreadQueueState).not.toHaveBeenCalled();
 expect(state.selectedThreadQueuedMessages.value).toEqual([]);
});
it('blocks rollback and file revert before touching read-only history', async()=>{
 gatewayMocks.rollbackThread.mockResolvedValue([]);
 const state=useDesktopState();
 gatewayMocks.resumeThread.mockResolvedValue({...detail(),readOnly:true,messages:[{id:'owned-user',role:'user',text:'fixture',turnId:'owned-turn',turnIndex:0}]});
 state.primeSelectedThread('readonly-rollback'); await state.loadMessages('readonly-rollback');
 await state.rollbackSelectedThread('owned-turn');
 expect(state.error.value).toMatch(/read-only/);
 expect(gatewayMocks.revertThreadFileChanges).not.toHaveBeenCalled();
 expect(gatewayMocks.rollbackThread).not.toHaveBeenCalled();
});

it('does not mark read-only history resumed or send to a writer owned elsewhere', async () => {
 const state=useDesktopState()
 gatewayMocks.resumeThread.mockResolvedValue({...detail('custom_endpoint','cx/gpt-6.1-sol'),readOnly:true})
 state.primeSelectedThread('readonly-owned')
 await state.loadMessages('readonly-owned')
 await expect(state.sendMessageToSelectedThread('must-not-be-sent')).rejects.toThrow(/read-only/)
 expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
})

  it.each(['selected', 'new'] as const)('fails closed for %s-thread sends while provider config is deferred', async (target) => {
    const state = useDesktopState()
    state.primeSelectedThread('provider-refresh-gap')
    gatewayMocks.getCurrentModelConfig.mockResolvedValueOnce({ model: 'gpt-old', providerId: 'openai', reasoningEffort: '', speedMode: 'standard' })
    gatewayMocks.getAvailableModelIds.mockResolvedValueOnce(['gpt-old'])
    gatewayMocks.resumeThread.mockImplementation(async (_id, options) => detail(options?.modelProvider, options?.model))
    gatewayMocks.startThread.mockResolvedValue({ threadId: 'new-provider-refresh-gap', model: 'gpt-old', modelProvider: 'openai' })
    await state.refreshAll(refresh)
    let release!: (value: { model: string; providerId: string; reasoningEffort: string; speedMode: 'standard' }) => void
    gatewayMocks.getCurrentModelConfig.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const refreshing = state.refreshAll(refresh)
    const sendResult = (target === 'selected'
      ? state.sendMessageToSelectedThread('safe deferred-config fixture')
      : state.sendMessageToNewThread('safe deferred-config fixture', '/fixture'))
      .then(() => null, (error: unknown) => error)
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      await sendResult
      expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
      expect(gatewayMocks.startThread).not.toHaveBeenCalled()
      expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
      expect(state.availableModelIds.value).toEqual([])
      expect(state.selectedModelId.value).toBe('')
    } finally {
      release({ model: 'Ggh', providerId: 'custom_endpoint', reasoningEffort: '', speedMode: 'standard' })
      await refreshing
    }
    expect(await sendResult).toBeInstanceOf(Error)
    if (target === 'selected') {
      await state.sendMessageToSelectedThread('safe latest-provider fixture')
      expect(gatewayMocks.resumeThread).toHaveBeenLastCalledWith('provider-refresh-gap', expect.objectContaining({ modelProvider: 'custom-endpoint', model: 'cx/gpt-6.1-sol' }))
      expect(gatewayMocks.startThreadTurn.mock.calls.at(-1)?.[3]).toBe('cx/gpt-6.1-sol')
    }
  })
  it('keeps routing invalid while an older refresh resolves during the latest deferred refresh', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('overlapping-provider-refresh')
    gatewayMocks.getCurrentModelConfig.mockResolvedValueOnce({ model: 'gpt-old', providerId: 'openai', reasoningEffort: '', speedMode: 'standard' })
    gatewayMocks.getAvailableModelIds.mockResolvedValueOnce(['gpt-old'])
    gatewayMocks.resumeThread.mockImplementation(async (_id, options) => detail(options?.modelProvider, options?.model))
    await state.refreshAll(refresh)
    const releases: Array<(value: { model: string; providerId: string; reasoningEffort: string; speedMode: 'standard' }) => void> = []
    gatewayMocks.getCurrentModelConfig.mockImplementation(() => new Promise(resolve => { releases.push(resolve) }))
    const older = state.refreshAll(refresh)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    const latest = state.refreshAll(refresh)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    try {
      releases[0]!({ model: 'gpt-old', providerId: 'openai', reasoningEffort: '', speedMode: 'standard' })
      await older
      const sendResult = await state.sendMessageToSelectedThread('safe overlapping fixture').then(() => null, (error: unknown) => error)
      expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
      expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
      expect(state.availableModelIds.value).toEqual([])
      expect(sendResult).toBeInstanceOf(Error)
    } finally {
      releases[1]!({ model: 'Ggh', providerId: 'custom_endpoint', reasoningEffort: '', speedMode: 'standard' })
      await latest
    }
    await state.sendMessageToSelectedThread('safe latest-only fixture')
    expect(gatewayMocks.resumeThread).toHaveBeenLastCalledWith('overlapping-provider-refresh', expect.objectContaining({ modelProvider: 'custom-endpoint', model: 'cx/gpt-6.1-sol' }))
  })
  it('blocks an in-flight resume overtaken by a same-provider endpoint save', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('save-race')
    await state.refreshAll(refresh)
    let release!: (value: ReturnType<typeof detail>) => void
    gatewayMocks.resumeThread.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const sending = state.sendMessageToSelectedThread('safe stale resume')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await state.refreshAll(refresh)
    release(detail('custom_endpoint', 'cx/gpt-6.1-sol'))
    await expect(sending).rejects.toThrow(/changed/)
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
  })
  it('never retries a custom turn on a rejected hard-coded ChatGPT fallback', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('unsupported-custom')
    gatewayMocks.resumeThread.mockImplementation(async (_id, options) => detail(options?.modelProvider, options?.model))
    await state.refreshAll(refresh)
    gatewayMocks.startThreadTurn.mockRejectedValueOnce(new Error("The 'cx/gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."))
    await expect(state.sendMessageToSelectedThread('safe rejected fixture')).rejects.toThrow(/ChatGPT/)
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    expect(state.availableModelIds.value).not.toContain('gpt-5.4-mini')
  })
  it('resolves the global catalog before first history resume after a browser reload', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('reload-existing-openai')
    await state.loadMessages('reload-existing-openai')
    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('reload-existing-openai', expect.objectContaining({ modelProvider: 'custom-endpoint', model: 'cx/gpt-6.1-sol' }))
    expect(gatewayMocks.getCurrentModelConfig.mock.invocationCallOrder[0]).toBeLessThan(gatewayMocks.resumeThread.mock.invocationCallOrder[0])
  })
  it('invalidates hydrated threads when saving a different endpoint for the same provider', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('same-provider-save')
    gatewayMocks.resumeThread.mockResolvedValue(detail('custom_endpoint', 'cx/gpt-6.1-sol'))
    await state.loadMessages('same-provider-save')
    await state.refreshAll(refresh)
    gatewayMocks.resumeThread.mockClear()
    await state.refreshAll(refresh)
    await state.sendMessageToSelectedThread('fixture only')
    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('same-provider-save', expect.objectContaining({ modelProvider: 'custom-endpoint' }))
  })
  it('blocks turn/start after a failed catalog refresh even if stored thread models remain', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('failed-catalog')
    await state.loadMessages('failed-catalog')
    gatewayMocks.getAvailableModelIds.mockRejectedValueOnce(new Error('fixture catalog unavailable'))
    await state.refreshAll(refresh)
    await expect(state.sendMessageToSelectedThread('no live request')).rejects.toThrow('fixture catalog unavailable')
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
  })
  it('blocks turn/start if an already-running thread ignores the provider override', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('running-old-provider')
    await state.loadMessages('running-old-provider')
    await state.refreshAll(refresh)
    await expect(state.sendMessageToSelectedThread('no live request')).rejects.toThrow(/different provider/)
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
  })
  it('rebinds an already-resumed OpenAI thread globally before starting a custom turn', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('existing-openai')
    await state.loadMessages('existing-openai')
    await state.refreshAll(refresh)
    gatewayMocks.resumeThread.mockImplementation(async (_id, options) => detail(options?.modelProvider, options?.model))
    await state.sendMessageToSelectedThread('safe fixture prompt')
    expect(gatewayMocks.resumeThread).toHaveBeenLastCalledWith('existing-openai', expect.objectContaining({ modelProvider: 'custom-endpoint', model: 'cx/gpt-6.1-sol' }))
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith('existing-openai', 'safe fixture prompt', [], 'cx/gpt-6.1-sol', 'medium', undefined, [], 'default')
    expect(gatewayMocks.resumeThread.mock.invocationCallOrder.at(-1)).toBeLessThan(gatewayMocks.startThreadTurn.mock.invocationCallOrder[0])
  })
  it('surfaces failed custom catalog refresh rather than keeping old ChatGPT models', async () => {
    const state = useDesktopState()
    gatewayMocks.getCurrentModelConfig.mockResolvedValueOnce({ model: 'gpt-old', providerId: 'openai', reasoningEffort: '', speedMode: 'standard' })
    gatewayMocks.getAvailableModelIds.mockResolvedValueOnce(['gpt-old'])
    await state.refreshAll(refresh)
    gatewayMocks.getAvailableModelIds.mockRejectedValueOnce(new Error('fixture provider catalog timeout'))
    await state.refreshAll(refresh)
    expect(state.error.value).toContain('fixture provider catalog timeout')
    expect(state.availableModelIds.value).toEqual([])
    expect(state.selectedModelId.value).toBe('')
  })
  it('does not inject an unverified configured Ggh into a custom catalog on ordinary refresh', async () => {
    const state = useDesktopState()
    await state.refreshAll({ ...refresh, providerChanged: false })
    expect(state.availableModelIds.value).toEqual(['cx/gpt-6.1-sol', 'provider-other'])
    expect(state.selectedModelId.value).toBe('cx/gpt-6.1-sol')
  })
  it('restores the same custom provider model slot for the custom alias', async () => {
    installWindow({ 'codex-web-local.selected-model-by-context.v1': JSON.stringify({ '__new-thread-provider__::custom-endpoint': 'provider-other' }) })
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'Ggh', providerId: ' CUSTOM ', reasoningEffort: '', speedMode: 'standard' })
    const state = useDesktopState()
    await state.refreshAll(refresh)
    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: 'custom-endpoint' }))
    expect(state.selectedModelId.value).toBe('provider-other')
  })
  it('refreshes the global custom catalog on an existing OpenAI thread after endpoint save', async () => {
    const state = useDesktopState()
    state.primeSelectedThread('01a03c9c-81a0-7d12-8c5d-717e34d480bc')
    await state.loadMessages(state.selectedThreadId.value)
    await state.refreshAll(refresh)
    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: 'custom-endpoint', requireProviderModels: true }))
    expect(state.availableModelIds.value).toEqual(['cx/gpt-6.1-sol', 'provider-other'])
    expect(state.selectedModelId.value).toBe('cx/gpt-6.1-sol')
    expect(state.availableModelIds.value).not.toContain('Ggh')
    expect(state.availableModelIds.value).not.toContain('gpt-5.4-mini')
  })
})
