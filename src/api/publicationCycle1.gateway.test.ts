import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAvailableModelIds, getThreadDetail, invalidateThreadResumeCache, resumeThread, startThread, forkThread, startThreadTurn } from './codexGateway'
import { getModelReasoningEfforts } from '../utils/modelCapabilities'
import type { ZenModelMetadata } from '../types/zenModels'
const rpc = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const resumed = (provider = 'custom_endpoint', id = 'fixture') => ({ thread: { id, turns: [], status: { type: 'idle' } }, model: 'fixture-model', modelProvider: provider, initialTurnsPage: { data: [], nextCursor: null } })
beforeEach(() => { invalidateThreadResumeCache() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); invalidateThreadResumeCache() })

describe('PUB-ULTRA-01 native metadata preservation', () => {
  it.each([
    { id: 'gpt-mismatch', model: 'gpt-other', supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] },
    { id: 'gpt-restricted', model: 'gpt-restricted', capabilities: { reasoning: false }, supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] },
  ])('does not grant native capabilities to a mismatched exact identity or explicitly nonreasoning row %j', async row => {
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => rpc({ data: [row] })))
    await getAvailableModelIds({ includeProviderModels: false, onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(getModelReasoningEfforts(row.id, metadata[0])).toEqual([])
  })
  it('never uses a raw native row alone to prove cx local Ultra, while retaining distinct Max', async () => {
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => rpc({ data: [{ id: 'cx/gpt-6.1-sol', model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] }] })))
    await getAvailableModelIds({ includeProviderModels: false, onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(getModelReasoningEfforts('cx/gpt-6.1-sol', metadata[0])).toEqual(['max'])
  })

  it('retains exact affirmed native effort lists without treating another namespace as an alias', async () => {
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => rpc({ data: [
      { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'Astra', supportedReasoningEfforts: ['high', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort })) },
      { id: 'gpt-empty', model: 'gpt-empty', supportedReasoningEfforts: [] },
      { id: 'gpt-malformed', model: 'gpt-malformed', supportedReasoningEfforts: [{ reasoningEffort: 'max' }, null] },
    ], nextCursor: null })))
    expect(await getAvailableModelIds({ includeProviderModels: false, onMetadata })).toEqual(['gpt-6-astra', 'gpt-empty', 'gpt-malformed'])
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(metadata.map(model => model.id)).toEqual(['gpt-6-astra', 'gpt-empty', 'gpt-malformed'])
    expect(getModelReasoningEfforts('gpt-6-astra', metadata[0])).toEqual(['high', 'max', 'ultra'])
    expect(getModelReasoningEfforts('gpt-empty', metadata[1])).toEqual([])
    expect(getModelReasoningEfforts('gpt-malformed', metadata[2])).toEqual([])
    expect(getModelReasoningEfforts('cx/gpt-6-astra')).not.toContain('ultra')
  })
  it.each([
    { supportedReasoningEfforts: [] },
    { supportedReasoningEfforts: null },
    { supportedReasoningEfforts: [{ reasoningEffort: 'max' }, null] },
    { supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }], reasoning: false },
    { capabilities: { reasoning: false } },
  ])('keeps restrictive native evidence over permissive exact provider metadata: %j', async native => {
    const provider = { id: 'gpt-6-astra', reasoningSource: 'provider-catalog', reasoningOptions: ['high', 'max', 'ultra'], upstreamApi: 'responses', supportsTools: true }
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('provider-models')
      ? new Response(JSON.stringify({ data: ['gpt-6-astra'], models: [provider] }), { status: 200 })
      : rpc({ data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra', ...native }] })))
    await getAvailableModelIds({ providerId: 'custom', onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(getModelReasoningEfforts('gpt-6-astra', metadata.find(model => model.id === 'gpt-6-astra'))).toEqual([])
    expect(metadata.find(model => model.id === 'gpt-6-astra')).toMatchObject({ upstreamApi: 'responses', supportsTools: true })
  })
  it('intersects native efforts with provider restrictions without adding choices', async () => {
    const provider = { id: 'gpt-6-astra', reasoningSource: 'provider-catalog', reasoningOptions: ['high', 'max'] }
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('provider-models')
      ? new Response(JSON.stringify({ data: ['gpt-6-astra'], models: [provider] }), { status: 200 })
      : rpc({ data: [{ id: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] }] })))
    await getAvailableModelIds({ providerId: 'custom', onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(getModelReasoningEfforts('gpt-6-astra', metadata.find(model => model.id === 'gpt-6-astra'))).toEqual(['max'])
  })
  it('cannot expand restrictive provider metadata with a permissive native row', async () => {

    const restricted = { id: 'gpt-6-astra', reasoningSource: 'provider-catalog', reasoningOptions: [] }
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('provider-models')
      ? new Response(JSON.stringify({ data: ['gpt-6-astra'], models: [restricted] }), { status: 200 })
      : rpc({ data: [{ id: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }] })))
    await getAvailableModelIds({ providerId: 'custom', onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(metadata.find(model => model.id === 'gpt-6-astra')).toEqual(restricted)
    expect(getModelReasoningEfforts('gpt-6-astra', metadata.find(model => model.id === 'gpt-6-astra'))).toEqual([])
  })
})

describe('PUB-ROUTE-01 exact gateway acquisition revision', () => {
  it.each(['default', 'plan'] as const)('rejects stale %s mode continuation before actual turn dispatch even with an explicit model', async mode => {
    const fetch = vi.fn(async () => rpc({ turn: { id: 'synthetic-turn-not-native' } }))
    vi.stubGlobal('fetch', fetch)
    const outcome = startThreadTurn('fixture', 'synthetic-only', [], 'fixture-model', 'max', undefined, [], mode)
      .then(() => null, (error: unknown) => error)
    invalidateThreadResumeCache()
    expect(await outcome).toBeInstanceOf(Error)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects invalidation while collaboration settings config resolution is deferred', async () => {
    let finish!: (value: Response) => void
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { method } = JSON.parse(String(init?.body)); methods.push(method)
      if (method !== 'config/read') return rpc({ turn: { id: 'synthetic-turn-not-native' } })
      return new Promise<Response>(resolve => { finish = resolve })
    }))
    const outcome = startThreadTurn('fixture', 'synthetic-only', [], undefined, 'max', undefined, [], 'default')
      .then(() => null, (error: unknown) => error)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    invalidateThreadResumeCache()
    finish(rpc({ config: { model: 'fixture-model', model_provider: 'custom_endpoint' } }))
    expect(await outcome).toBeInstanceOf(Error)
    expect(methods).toEqual(['config/read'])
  })


  it.each(['resume', 'detail', 'start', 'fork'] as const)('rejects stale %s completion at the real transport seam', async path => {
    const requests: Array<{ method: string }> = []
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)); requests.push(request)
      if (request.method === 'thread/items/list') return rpc({ data: [], nextCursor: null })
      return new Promise<Response>(resolve => { finish = resolve })
    }))
    const operation = path === 'resume' ? resumeThread('stale-resume', { modelProvider: 'custom' })
      : path === 'detail' ? getThreadDetail('stale-detail', { modelProvider: 'custom' })
      : path === 'start' ? startThread('/fixture', 'fixture-model')
      : forkThread('stale-fork', '/fixture', 'fixture-model')
    const outcome = operation.then(() => null, (error: unknown) => error)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    invalidateThreadResumeCache()
    finish(rpc(resumed()))
    expect(await outcome).toBeInstanceOf(Error)
    expect(requests).toHaveLength(1) // No obsolete hydration/dispatch after invalidation.
  })
  it('rejects a warm coalesced resume if invalidated before its caller continuation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return JSON.parse(String(init?.body)).method === 'thread/items/list' ? rpc({ data: [], nextCursor: null }) : rpc(resumed())
    }))
    await resumeThread('warm-stale', { modelProvider: 'custom' })
    const outcome = resumeThread('warm-stale', { modelProvider: 'custom' }).then(() => null, (error: unknown) => error)
    invalidateThreadResumeCache()
    expect(await outcome).toBeInstanceOf(Error)
  })
})
