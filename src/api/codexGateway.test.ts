import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ref } from 'vue'
import type { ThreadGoal } from './codexGateway'
import * as gateway from './codexGateway'
import { clearThreadGoal, getAvailableModelIds, getGoalBudgetOwnerAuthorization, getOlderThreadMessages, getThreadDetail, getThreadGoal, resumeThread, setCodexSpeedMode, setThreadGoal, startThreadTurn } from './codexGateway'

function mockRpcFetch(): { requests: Array<{ method: string, params: Record<string, unknown> }> } {
  const requests: Array<{ method: string, params: Record<string, unknown> }> = []

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
      : { method: '', params: {} }

    requests.push(body)

    return new Response(JSON.stringify({
      result: {
        thread: { turns: [], status: 'idle' },
        model: 'model-x',
        modelProvider: 'openai',
        initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
        turn: {
          id: `turn-${requests.length}`,
        },
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }))

  return { requests }
}

describe('startThreadTurn collaboration mode payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends default collaboration mode explicitly after a plan turn', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'make a plan', [], 'gpt-5.4', 'medium', undefined, [], 'plan')
    await startThreadTurn('thread-1', 'implement it', [], 'gpt-5.4', 'medium', undefined, [], 'default')

    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
    expect(requests[1].method).toBe('turn/start')
    expect(requests[1].params.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
  })

  it('preserves Ultra for the Astra custom model', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-astra', 'solve the hard problem', [], 'cx/gpt-6-astra', 'ultra')

    expect(requests[0].params).toMatchObject({
      model: 'cx/gpt-6-astra',
      effort: 'ultra',
    })
  })
})

describe('setCodexSpeedMode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('disables the persisted Fast feature when switching back to Standard', async () => {
    const { requests } = mockRpcFetch()

    await setCodexSpeedMode('fast')
    await setCodexSpeedMode('standard')

    expect((requests[0].params as { edits: unknown }).edits).toEqual([
      { keyPath: 'features.fast_mode', value: true, mergeStrategy: 'upsert' },
      { keyPath: 'service_tier', value: 'fast', mergeStrategy: 'upsert' },
    ])
    expect((requests[1].params as { edits: unknown }).edits).toEqual([
      { keyPath: 'features.fast_mode', value: false, mergeStrategy: 'upsert' },
      { keyPath: 'service_tier', value: null, mergeStrategy: 'replace' },
    ])
  })
})

describe('getAvailableModelIds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses provider models without waiting for model/list when provider models are required', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({
          data: ['big-pickle', 'deepseek-v4-flash-free'],
          exclusive: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected request ${String(input)}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
    })).resolves.toEqual(['big-pickle', 'deepseek-v4-flash-free'])
    expect(requests).toEqual(['/codex-api/provider-models'])
  })

  it('requests models for an explicit thread provider', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models?provider=opencode-zen') {
        return new Response(JSON.stringify({
          data: ['big-pickle', 'ring-2.6-1t-free'],
          exclusive: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected request ${String(input)}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })).resolves.toEqual(['big-pickle', 'ring-2.6-1t-free'])
    expect(requests).toEqual(['/codex-api/provider-models?provider=opencode-zen'])
  })

  it('falls back to model/list when provider models are optional and unavailable', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({ data: [] }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string }
        : { method: '' }
      expect(body.method).toBe('model/list')
      return new Response(JSON.stringify({
        result: {
          data: [
            { id: 'gpt-5.5' },
            { model: 'gpt-5.4-mini' },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
    })).resolves.toEqual(['gpt-5.5', 'gpt-5.4-mini'])
    expect(requests).toEqual(['/codex-api/provider-models', '/codex-api/rpc'])
  })
})

describe('getThreadDetail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads modelProvider from nested thread payloads returned by bounded thread/resume', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      expect(body.method).toBe('thread/resume')
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: body.params.threadId,
            modelProvider: 'opencode_zen',
            turns: [],
          },
          initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
          turnsBackwardsCursor: null,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadDetail('legacy-thread')).resolves.toMatchObject({
      modelProvider: 'opencode_zen',
    })
  })
})


// Execute the real App functions without mounting unrelated routes or contacting a live provider.
function appFunctions(names: string[], dependencies: Record<string, unknown>, source = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')) {
  const script = source.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
  const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = ast.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && Boolean(statement.name && names.includes(statement.name.text)))
  expect(declarations.map(declaration => declaration.name!.text).sort()).toEqual([...names].sort())
  const executable = ts.transpileModule(declarations.map(declaration => declaration.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(dependencies), `${executable}; return {${names.join(',')}}`)(...Object.values(dependencies))
}
function editorFixture(overrides: Partial<ThreadGoal> = {}) {
  const selectedThreadId = ref('recovery-thread')
  const selectedThreadGoal = ref<ThreadGoal | null>({ threadId: 'recovery-thread', objective: 'Keep durable goal',
    status: 'budgetLimited', tokenBudget: 100, tokensUsed: 100, timeUsedSeconds: 20, createdAt: 1, updatedAt: 2, ...overrides })
  const set = vi.fn(async (..._args: unknown[]) => selectedThreadGoal.value)
  const dependencies = { selectedThreadId, selectedThreadGoal, isSavingThreadGoal: ref(false),
    goalEditorObjective: ref('Keep durable goal'), goalEditorStatus: ref('active'), goalEditorTokenBudget: ref('100'),
    goalEditorError: ref(''), goalBudgetOwnerAuthorized: ref(true), goalBudgetAuditStatus: ref(''), isGoalEditorOpen: ref(true),
    isHomeRoute: ref(false), isLoadingThreadGoal: ref(false), goalEditorContextVersion: ref(0), setThreadGoal: set, window: { confirm: vi.fn(() => true) },
    threadGoalState: { loaded: ref(true), save: vi.fn(async (input: unknown) => { await set(input); return true }),
      resume: vi.fn(async (budget: number) => { await set({ status: 'active', tokenBudget: budget }); return true }) },
  }
  return { ...dependencies, run: appFunctions(['onSaveThreadGoal'], dependencies).onSaveThreadGoal }
}

describe('Goal editor reconciliation safety', () => {
  it('requires an explicit owner budget adjustment instead of rearming an exhausted same numeric budget', async () => {
    const fixture = editorFixture()
    await fixture.run()
    expect(fixture.setThreadGoal).not.toHaveBeenCalled()
    expect(fixture.goalEditorError.value).toMatch(/budget.*adjust|adjust.*budget/i)
    expect(fixture.selectedThreadGoal.value).toMatchObject({ status: 'budgetLimited', tokenBudget: 100, tokensUsed: 100 })
  })
  it('preserves the owner-approved finite adjustment payload without replacing the objective', async () => {
    const fixture = editorFixture()
    fixture.goalEditorTokenBudget.value = '200'
    await fixture.run()
    const input = fixture.setThreadGoal.mock.calls[0]!
    expect(input.at(-1)).toEqual({ status: 'active', tokenBudget: 200 })
    expect(fixture.window.confirm).toHaveBeenCalledWith(expect.stringContaining('preserves 100'))
  })
})


describe('finite owner-authorized Goal recovery', () => {
  afterEach(() => vi.unstubAllGlobals())
  function recoveryFixture(overrides: Partial<ThreadGoal> = {}, authorized = true, returned: Partial<ThreadGoal> = {}) {
    const existing = { threadId: 'recover', objective: 'Preserve durable objective', status: 'budgetLimited',
      tokenBudget: 100, tokensUsed: 100, timeUsedSeconds: 15, createdAt: 3, updatedAt: 4, ...overrides }
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/codex-api/owner/authorization') return Response.json({ authorized })
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return Response.json({ result: { goal: body.method === 'thread/goal/get' ? existing : {
        ...existing, status: 'active', tokenBudget: body.params.tokenBudget, updatedAt: 5, ...returned,
      } } })
    }))
    return requests
  }
  // Deliberately call the public recovery seam so a missing implementation is an assertion failure.
  const recover = (budget: number) => (gateway as unknown as { resumeThreadGoal: (id: string, budget: number, confirmed: boolean) => Promise<ThreadGoal> }).resumeThreadGoal('recover', budget, true)
  it('recovers only through an explicit finite owner-approved total budget while preserving durable accounting', async () => {
    const requests = recoveryFixture()
    expect(gateway).toHaveProperty('resumeThreadGoal')
    await expect(recover(200)).resolves.toMatchObject({ status: 'active', tokenBudget: 200, objective: 'Preserve durable objective', tokensUsed: 100, timeUsedSeconds: 15, createdAt: 3 })
    expect(requests).toEqual([
      { method: 'thread/goal/get', params: { threadId: 'recover' } },
      { method: 'thread/goal/set', params: { threadId: 'recover', status: 'active', tokenBudget: 200, ownerConfirmed: true } },
    ])
  })
  it.each([100, 99, 0, -1, Infinity, NaN, 100.5, null, undefined])('refuses exhausted, unlimited or invalid total budget %s without writing', async budget => {
    const requests = recoveryFixture()
    expect(gateway).toHaveProperty('resumeThreadGoal')
    await expect(recover(budget as number)).rejects.toThrow(/budget/i)
    expect(requests.filter(request => request.method === 'thread/goal/set')).toEqual([])
  })
  it('refuses the unchanged numeric budget even if the stored status is limited before usage reaches that total', async () => {
    const requests = recoveryFixture({ tokensUsed: 50 })
    expect(gateway).toHaveProperty('resumeThreadGoal')
    await expect(recover(100)).rejects.toThrow(/adjust/i)
    expect(requests.filter(request => request.method === 'thread/goal/set')).toEqual([])
  })
  it('requires owner authorization without sending a recovery mutation', async () => {
    const requests = recoveryFixture({}, false)
    expect(gateway).toHaveProperty('resumeThreadGoal')
    await expect(recover(200)).rejects.toThrow(/owner/i)
    expect(requests.filter(request => request.method === 'thread/goal/set')).toEqual([])
  })
  it('refuses a budget read belonging to another thread before any recovery mutation', async () => {
    const requests = recoveryFixture({ threadId: 'different' })
    await expect(recover(200)).rejects.toThrow(/different thread/i)
    expect(requests.filter(request => request.method === 'thread/goal/set')).toEqual([])
  })
  it('rejects a recovery result that silently resets consumed usage', async () => {
    recoveryFixture({}, true, { tokensUsed: 0 })
    expect(gateway).toHaveProperty('resumeThreadGoal')
    await expect(recover(200)).rejects.toThrow(/preserv|verif/i)
  })
})


describe('Goal editor captured-thread response isolation', () => {
  it('keeps a late save from replacing the selected thread goal or closing its editor', async () => {
    const fixture = editorFixture({ status: 'paused', tokenBudget: 200 })
    fixture.goalEditorTokenBudget.value = '200'
    let finish!: (value: ThreadGoal | null) => void
    fixture.setThreadGoal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fixture.threadGoalState.save.mockImplementationOnce(async input => { await fixture.setThreadGoal(input); return false })
    const saving = fixture.run()
    const captured = fixture.selectedThreadGoal.value
    fixture.selectedThreadId.value = 'b'
    fixture.selectedThreadGoal.value = { ...captured!, threadId: 'b', objective: 'B goal' }
    finish(captured)
    await saving
    expect(fixture.selectedThreadGoal.value?.objective).toBe('B goal')
    expect(fixture.isGoalEditorOpen.value).toBe(true)
  })
  it('does not open a stale editor or retain owner authorization when its authorization read resolves after a switch', async () => {
    const fixture = editorFixture()
    fixture.isGoalEditorOpen.value = false
    let authorize!: (value: boolean) => void
    const dependencies = { ...fixture, isGoalBudgetEditorOpen: ref(false), getGoalBudgetOwnerAuthorization: vi.fn(() => new Promise<boolean>(resolve => { authorize = resolve })) }
    const opening = appFunctions(['openGoalEditor'], dependencies).openGoalEditor()
    fixture.selectedThreadId.value = 'b'
    authorize(true)
    await opening
    expect(fixture.isGoalEditorOpen.value).toBe(false)
    expect(fixture.goalBudgetOwnerAuthorized.value).toBe(false)
  })
})

describe('startup provider discovery reconciliation', () => {
  function startupFixture() {
    const calls: string[] = []
    let discovery!: (value: unknown) => void
    const dependencies = { router: { isReady: vi.fn(async () => undefined) }, route: { name: 'thread' }, routeThreadId: ref('startup-thread'),
      primeSelectedThread: vi.fn(), refreshAll: vi.fn(async () => { calls.push('refresh'); return undefined }),
      ensureThreadMessagesLoaded: vi.fn(async () => { calls.push('messages') }), loadAccountsState: vi.fn(), applyLaunchProjectPathFromUrl: vi.fn(),
      hasInitialized: ref(false), syncThreadSelectionWithRoute: vi.fn(), startPolling: vi.fn(),
      getFreeModeStatus: vi.fn(() => { calls.push('discovery'); return new Promise(resolve => { discovery = resolve }) }),
      selectedProvider: ref('codex'), freeModeEnabled: ref(false), freeModeHasCustomKey: ref(false), freeModeCustomKeyMasked: ref(null),
      customEndpointUrl: ref(''), customEndpointWireApi: ref('responses'), openRouterWireApi: ref('responses'),
      externalCodexAuthAvailable: false, externalAuthImportAttempted: false, maybeImportExternalCodexAuthAccount: vi.fn(async () => false),
      providerError: ref(''),
    }
    const functions = appFunctions(['initialize', 'loadFreeModeStatus'], dependencies)
    return { ...dependencies, calls, ...functions, resolveDiscovery: (provider = 'custom') => discovery({ enabled: true, provider, customBaseUrl: 'http://fixture', hasCodexAuth: false }) }
  }
  it('finishes provider discovery before one initial refresh and loads deep-link history only after the global catalog', async () => {
    const fixture = startupFixture()
    const initializing = fixture.initialize()
    await Promise.resolve()
    expect(fixture.calls).toEqual(['discovery'])
    fixture.resolveDiscovery()
    await initializing
    expect(fixture.calls).toEqual(['discovery', 'refresh', 'messages'])
    expect(fixture.refreshAll).toHaveBeenCalledTimes(1)
    expect(fixture.refreshAll).toHaveBeenCalledWith(expect.objectContaining({ includeSelectedThreadMessages: false, providerChanged: true, awaitAncillaryRefreshes: true }))
    expect(fixture.ensureThreadMessagesLoaded).toHaveBeenCalledWith('startup-thread', { silent: true })
  })
  it('folds provider and external-auth discovery changes into the one deferred startup refresh', async () => {
    const fixture = startupFixture()
    fixture.maybeImportExternalCodexAuthAccount.mockResolvedValueOnce(true)
    const initializing = fixture.initialize()
    await Promise.resolve()
    fixture.resolveDiscovery('openrouter')
    await initializing
    expect(fixture.refreshAll).toHaveBeenCalledTimes(1)
  })
  it('preserves synchronous route invalidation before a non-startup provider-change auth import can settle', async () => {
    const fixture = startupFixture()
    let finishImport!: (value: boolean) => void
    fixture.maybeImportExternalCodexAuthAccount.mockImplementationOnce(() => new Promise(resolve => { finishImport = resolve }))
    const discovery = fixture.loadFreeModeStatus()
    fixture.resolveDiscovery('openrouter')
    await vi.waitFor(() => expect(finishImport).toBeTypeOf('function'))
    try {
      expect(fixture.refreshAll).toHaveBeenCalledWith(expect.objectContaining({ providerChanged: true }))
    } finally {
      finishImport(true)
      await discovery
    }
  })
  it('removes the independent mounted discovery call that races the initial refresh', () => {
    const source = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
    const mounted = source.split('onMounted(() => {')[1]!.split('\n})')[0]!
    expect(mounted).not.toContain('void loadFreeModeStatus()')
  })
})


describe('startup safety before provider discovery', () => {
  it.each(['selected', 'new'] as const)('blocks %s-thread submission synchronously while startup discovery is pending', async target => {
    const source = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
    const ast = ts.createSourceFile('App.ts', source.split('<script setup lang="ts">')[1]!.split('</script>')[0]!, ts.ScriptTarget.Latest, true)
    const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === (target === 'new' ? 'submitFirstMessageForNewThread' : 'onSubmitThreadMessage')) as ts.FunctionDeclaration
    expect(declaration).toBeDefined()
    const send = vi.fn()
    const dependencies = { hasInitialized: ref(false), desktopError: ref(''), sendMessageToSelectedThread: send, sendMessageToNewThread: send,
      scheduleMobileConversationJumpToLatest: vi.fn(), editingQueuedMessageState: ref(null), isHomeRoute: ref(false), selectedThreadId: ref('fixture'),
      isSendingMessage: ref(false), newThreadCwd: ref('/fixture'), newThreadRuntime: ref('local'), newThreadFolderOptions: ref([]),
      resolvePreferredLocalCwd: vi.fn(() => '/fixture'), worktreeInitStatus: ref({ phase: 'idle' }), threadComposerRef: ref(null),
      newWorktreeBaseBranch: ref('main'), isCreatingNewThread: ref(false), isNewThreadCwdGitRepo: ref(false) }
    const submit = appFunctions([declaration.name!.text], dependencies)[declaration.name!.text]
    if (target === 'new') await submit('non-generation fixture', [], [], [])
    else await submit({ text: 'non-generation fixture', imageUrls: [], fileAttachments: [], skills: [], mode: 'steer' })
    expect(send).not.toHaveBeenCalled()
    expect(dependencies.desktopError.value).toMatch(/provider|initializ|startup/i)
  })
  it('sets recovery and owner budget input colors in the shared dark stylesheet', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8')
    for (const selector of ['.thread-goal-card', '.thread-goal-editor', '.thread-goal-resume', '.thread-goal-budget-editor input']) {
      expect(css).toContain(`:root.dark ${selector}`)
    }
  })
  it('makes the recovery action open the numeric owner budget editor instead of resuming unlimited', () => {
    const source = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
    expect(source).toContain('class="thread-goal-resume"')
    expect(source).toContain('Adjust budget to resume')
    expect(source).not.toContain('Resume unlimited')
  })
})


describe('Goal editor numeric rearm boundaries', () => {
  it.each([{ status: 'paused' as const, tokenBudget: null }, { status: 'paused' as const, tokenBudget: 100 }])('rejects a status-only rearm without explicit remaining budget %j', async overrides => {
    const fixture = editorFixture(overrides)
    fixture.goalEditorTokenBudget.value = overrides.tokenBudget === null ? '' : '100'
    await fixture.run()
    expect(fixture.setThreadGoal).not.toHaveBeenCalled()
    expect(fixture.goalEditorError.value).toMatch(/budget/i)
  })
  it('permits a paused Goal with positive remaining explicit numeric budget without resetting it', async () => {
    const fixture = editorFixture({ status: 'paused', tokenBudget: 200 })
    fixture.goalEditorTokenBudget.value = '200'
    await fixture.run()
    expect(fixture.setThreadGoal.mock.calls[0]!.at(-1)).toEqual({ objective: 'Keep durable goal', status: 'active' })
  })
  it('leaves the owner-only adjustment unpublished when the owner denies confirmation', async () => {
    const fixture = editorFixture()
    fixture.goalEditorTokenBudget.value = '200'
    fixture.window.confirm.mockReturnValue(false)
    await fixture.run()
    expect(fixture.setThreadGoal).not.toHaveBeenCalled()
  })
})


describe('actual startup request counts', () => {
  afterEach(() => vi.unstubAllGlobals())
  it.each(['home', 'thread'] as const)('uses one global catalog and one rate refresh on %s startup without generation', async routeName => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
      setTimeout: vi.fn((callback: () => void, delay: number) => { if (delay === 0) callback(); return 0 }), clearTimeout: vi.fn() })
    const methods: string[] = [], urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      if (url === '/codex-api/free-mode/status') return Response.json({ enabled: true, provider: 'custom', hasCodexAuth: false })
      if (url.startsWith('/codex-api/provider-models')) return Response.json({ data: ['fixture-model'], exclusive: true, providerId: 'custom-endpoint' })
      if (url === '/codex-api/thread-queue-state') return Response.json({})
      if (url === '/codex-api/thread-titles') return Response.json({ titles: {} })
      if (url === '/codex-api/workspace-roots-state') return Response.json({ roots: [] })
      if (url !== '/codex-api/rpc') throw new Error(`unexpected fixture request: ${url}`)
      const body = JSON.parse(String(init?.body))
      methods.push(body.method)
      if (body.method === 'config/read') return Response.json({ result: { config: { model: 'fixture-model', model_provider: 'custom_endpoint' } } })
      if (body.method === 'thread/list') return Response.json({ result: { data: [{ id: 'startup-integration', cwd: '/fixture', preview: 'Existing thread', createdAt: 1, updatedAt: 2, modelProvider: 'openai', status: { type: 'idle' } }], nextCursor: null } })
      if (body.method === 'thread/resume' || body.method === 'thread/read') return Response.json({ result: {
        thread: { id: 'startup-integration', cwd: '/fixture', turns: [], status: 'idle', modelProvider: 'custom_endpoint' },
        model: 'fixture-model', modelProvider: 'custom_endpoint', initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
      } })
      if (body.method === 'account/rateLimits/read') return Response.json({ result: { rateLimits: null } })
      if (body.method === 'collaborationMode/list' || body.method === 'skills/list') return Response.json({ result: { data: [] } })
      throw new Error(`generation or unexpected fixture RPC prohibited: ${body.method}`)
    }))
    const { useDesktopState } = await import('../composables/useDesktopState')
    const state = useDesktopState()
    const dependencies = { ...state, router: { isReady: async () => undefined }, route: { name: routeName }, routeThreadId: ref(routeName === 'thread' ? 'startup-integration' : ''),
      getFreeModeStatus: gateway.getFreeModeStatus, selectedProvider: ref('codex'), freeModeEnabled: ref(false), freeModeHasCustomKey: ref(false), freeModeCustomKeyMasked: ref(null),
      customEndpointUrl: ref(''), customEndpointWireApi: ref('responses'), openRouterWireApi: ref('responses'),
      externalCodexAuthAvailable: false, externalAuthImportAttempted: false, maybeImportExternalCodexAuthAccount: async () => false,
      loadAccountsState: vi.fn(), applyLaunchProjectPathFromUrl: vi.fn(), hasInitialized: ref(false), syncThreadSelectionWithRoute: vi.fn(), startPolling: vi.fn() }
    const source = process.env.GOAL_STARTUP_BASELINE_APP
      ? readFileSync(process.env.GOAL_STARTUP_BASELINE_APP, 'utf8') : undefined
    const functions = appFunctions(['initialize', 'loadFreeModeStatus'], dependencies, source)
    const starting = functions.initialize()
    const mountedDiscovery = source?.includes('void loadFreeModeStatus()') ? functions.loadFreeModeStatus() : Promise.resolve()
    await Promise.all([starting, mountedDiscovery])
    await vi.waitFor(() => expect(methods.filter(method => method === 'account/rateLimits/read').length).toBeGreaterThan(0))
    console.info('synthetic startup request counts', { route: routeName, config: methods.filter(method => method === 'config/read').length,
      providerModels: urls.filter(url => url.startsWith('/codex-api/provider-models')).length,
      rateLimits: methods.filter(method => method === 'account/rateLimits/read').length, threadList: methods.filter(method => method === 'thread/list').length,
      resume: methods.filter(method => method === 'thread/resume').length })
    expect(state.availableModelIds.value).toEqual(['fixture-model'])
    expect(state.error.value).toBe('')
    expect(urls.filter(url => url.startsWith('/codex-api/provider-models'))).toHaveLength(1)
    expect(methods.filter(method => method === 'account/rateLimits/read')).toHaveLength(1)
    expect(methods.filter(method => method === 'config/read')).toHaveLength(1)
    expect(urls.filter(url => url === '/codex-api/free-mode/status')).toHaveLength(1)
    expect(methods.some(method => /^turn\//.test(method))).toBe(false)
    if (routeName === 'thread') expect(methods.indexOf('thread/resume')).toBeGreaterThan(methods.indexOf('config/read'))
  })
})

describe('thread goals', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads, updates, and clears persisted thread goals', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
      requests.push(body)
      if (body.method === 'thread/goal/clear') {
        return new Response(JSON.stringify({ result: { cleared: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ result: { goal: {
        threadId: body.params.threadId,
        objective: body.params.objective ?? 'Existing objective',
        status: body.params.status ?? 'blocked',
        tokenBudget: null,
        tokensUsed: 12,
        timeUsedSeconds: 34,
        createdAt: 1,
        updatedAt: 2,
      } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getThreadGoal('thread-goal')).resolves.toMatchObject({ objective: 'Existing objective', status: 'blocked' })
    await expect(setThreadGoal('thread-goal', { objective: 'Edited objective', status: 'active' })).resolves.toMatchObject({ objective: 'Edited objective', status: 'active' })
    await expect(setThreadGoal('thread-goal', { tokenBudget: 100_000, status: 'active', ownerConfirmed: true })).resolves.toMatchObject({ objective: 'Existing objective', status: 'active' })
    await expect(clearThreadGoal('thread-goal')).resolves.toBe(true)
    expect(requests).toEqual([
      { method: 'thread/goal/get', params: { threadId: 'thread-goal' } },
      { method: 'thread/goal/set', params: { threadId: 'thread-goal', objective: 'Edited objective', status: 'active' } },
      { method: 'thread/goal/set', params: { threadId: 'thread-goal', tokenBudget: 100_000, status: 'active', ownerConfirmed: true } },
      { method: 'thread/goal/clear', params: { threadId: 'thread-goal' } },
    ])
  })

  it('checks owner authorization through the authenticated WebUI endpoint', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ authorized: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getGoalBudgetOwnerAuthorization()).resolves.toBe(true)
    expect(requests).toEqual(['/codex-api/owner/authorization'])
  })
})

describe('resumeThread', () => {
  it('requests a bounded recent turn page instead of hydrating full history', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> } : { method: '', params: {} }
      requests.push(body)
      if (body.method === 'thread/resume') {
        return new Response(JSON.stringify({ result: {
          thread: { turns: [], status: 'idle' },
          model: 'model-x',
          modelProvider: 'openai',
          initialTurnsPage: { data: [], nextCursor: 'initial-older-page-cursor', backwardsCursor: 'opposite-direction' },
          turnsBackwardsCursor: 'head-cursor-fallback',
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const resumed = await resumeThread('paged-thread')
    expect(requests[0]).toEqual({
      method: 'thread/resume',
      params: {
        threadId: 'paged-thread',
        excludeTurns: true,
        initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' },
      },
    })
    expect(resumed.olderCursor).toBe('initial-older-page-cursor')
    expect(resumed.hasMoreOlder).toBe(true)
  })

  it('loads older turns with the opaque app-server cursor', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      return new Response(JSON.stringify({
        result: {
          data: [
            { id: 'turn-newer', items: [], status: 'completed', itemsView: 'full', error: null, startedAt: null, completedAt: null, durationMs: null },
            { id: 'turn-older', items: [], status: 'completed', itemsView: 'full', error: null, startedAt: null, completedAt: null, durationMs: null },
          ],
          nextCursor: 'next-opaque-cursor',
          backwardsCursor: 'reverse-cursor',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const page = await getOlderThreadMessages('paged-thread', 'opaque+cursor/1', 10)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('cursor=opaque%2Bcursor%2F1')
    expect(requests[0]).not.toContain('beforeTurnId')
    expect(page.nextCursor).toBe('next-opaque-cursor')
    expect(page.turnIndexByTurnId).toEqual({ 'turn-older': 0, 'turn-newer': 1 })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('coalesces repeated resume failures for the same thread', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Response(JSON.stringify({ error: 'no rollout found for thread id missing-thread' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const results = await Promise.allSettled([
      resumeThread('missing-thread'),
      resumeThread('missing-thread'),
    ])

    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'missing-thread', excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' } } },
    ])
  })

  it('retries legacy custom_endpoint threads through the configured OpenAI endpoint', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      if (requests.length === 1) {
        return new Response(JSON.stringify({ error: 'Model provider `custom_endpoint` not found' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        result: { model: 'gpt-5.6-terra', modelProvider: 'openai', thread: { turns: [] } },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(resumeThread('legacy-custom-endpoint-thread')).resolves.toMatchObject({
      modelProvider: 'openai',
    })
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'legacy-custom-endpoint-thread', excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' } } },
      { method: 'thread/resume', params: { threadId: 'legacy-custom-endpoint-thread', excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' }, modelProvider: 'openai' } },
    ])
  })

  it('reads a thread when another Codex process owns its active writer', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      if (requests.length === 1) {
        return new Response(JSON.stringify({ error: 'thread shared-thread already has an active writer' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (body.method === 'thread/read') return new Response(JSON.stringify({ result: { thread: { modelProvider: 'openai', turns: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ result: { data: [], nextCursor: null, backwardsCursor: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(resumeThread('shared-thread')).resolves.toMatchObject({ modelProvider: 'openai' })
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'shared-thread', excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' } } },
      { method: 'thread/read', params: { threadId: 'shared-thread', includeTurns: false } },
      { method: 'thread/turns/list', params: { threadId: 'shared-thread', limit: 10, sortDirection: 'desc', itemsView: 'full' } },
    ])
  })

  it('evicts a stalled resume so later resume attempts are not pinned forever', async () => {
    vi.useFakeTimers()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Promise<Response>(() => undefined)
    }))

    const first = resumeThread('stalled-thread')
    void resumeThread('stalled-thread')
    expect(requests).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)

    const retried = resumeThread('stalled-thread')
    expect(retried).not.toBe(first)
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'stalled-thread', excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' } } },
      { method: 'thread/resume', params: { threadId: 'stalled-thread', excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' } } },
    ])
  })
})
