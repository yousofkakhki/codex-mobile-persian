import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearThreadGoal, getAvailableModelIds, getOlderThreadMessages, getThreadDetail, getThreadGoal, resumeThread, setCodexSpeedMode, setThreadGoal, startThreadTurn } from './codexGateway'

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
    await expect(clearThreadGoal('thread-goal')).resolves.toBe(true)
    expect(requests).toEqual([
      { method: 'thread/goal/get', params: { threadId: 'thread-goal' } },
      { method: 'thread/goal/set', params: { threadId: 'thread-goal', objective: 'Edited objective', status: 'active' } },
      { method: 'thread/goal/clear', params: { threadId: 'thread-goal' } },
    ])
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
