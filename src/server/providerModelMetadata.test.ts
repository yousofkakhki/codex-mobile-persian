import { describe, expect, it, vi } from 'vitest'

describe('provider catalog metadata', () => {
  it('preserves exact aliases and advertised limits for Responses provider metadata', async () => {
    const api = await import('./providerModelMetadata').catch(() => null)
    expect(api?.normalizeProviderModelMetadata, 'provider metadata normalization must exist').toBeTypeOf('function')
    const models = api!.normalizeProviderModelMetadata({ data: [{
      id: 'cx/gpt-6-luna[1m]', context_length: 872000, max_completion_tokens: 128000,
      capabilities: { reasoning: true, tools: true, vision: true },
    }, { id: 'unknown-model', context_length: -1 }] })
    expect(models).toMatchObject([
      { id: 'cx/gpt-6-luna[1m]', name: 'cx/gpt-6-luna[1m]', upstreamApi: 'responses', routingSource: 'provider-catalog',
        contextWindow: 872000, maxOutputTokens: 128000, supportsReasoning: true, supportsTools: true, inputModalities: ['text', 'image'] },
      { id: 'unknown-model', contextWindow: null, maxOutputTokens: null, supportsReasoning: null },
    ])
  })
  it('takes explicit efforts ahead of inspected cx fallback and respects reasoning=false', async () => {
    const { normalizeProviderModelMetadata } = await import('./providerModelMetadata')
    const models = normalizeProviderModelMetadata({ data: [
      { id: 'cx/gpt-6.1-sol', capabilities: { contextWindow: 1050000, maxOutput: 128000 },
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoning_effort: 'high' }, 'max', 'max'] },
      { id: 'cx/gpt-6-astra[1m]', capabilities: { reasoning: true, thinkingEffortSupported: false } },
      { id: 'cx/gpt-6.1-luna-review', capabilities: { thinkingEffortSupported: false } },
      { id: 'cx/gpt-reserve', capabilities: { reasoning: false }, thinkingLevels: ['high'] },
      { id: 'unknown-model' },
      { id: 'cx/gpt-6-sol', thinkingLevels: [] },
    ] })
    expect(models).toMatchObject([
      { contextWindow: 1050000, maxOutputTokens: 128000, reasoningOptions: ['low', 'high', 'max'], reasoningSource: 'provider-catalog' },
      { reasoningOptions: ['low', 'medium', 'high', 'xhigh'], reasoningSource: 'codex-family-fallback' },
      { reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningSource: 'codex-family-fallback' },
      { supportsReasoning: false, reasoningOptions: [] },
      { reasoningOptions: [] },
      { reasoningOptions: [], reasoningSource: 'provider-catalog' },
    ])
    expect(models[4]?.reasoningSource).toBeUndefined()
  })

  it('keeps metadata IDs coherent with strict catalog IDs without repairing or inventing tokens', async () => {
    const { normalizeProviderModelMetadata } = await import('./providerModelMetadata')
    const models = normalizeProviderModelMetadata({ data: [], models: [
      'literal-model', { id: 'cx/gpt-6-sol[1m]' }, { id: 'cx/gpt-6-sol[1m]' },
      { id: ' exact token ', model: 'preferred-after-id', slug: 'last-choice' },
      { model: 'model-choice', slug: 'slug-choice' }, { slug: 'slug-only' }, null,
    ] })
    expect(models.map(model => model.id)).toEqual(['literal-model', 'cx/gpt-6-sol[1m]', ' exact token ', 'model-choice', 'slug-only'])
    expect(normalizeProviderModelMetadata(null)).toEqual([])
    expect(normalizeProviderModelMetadata({ data: [null, { id: '' }, { id: 1 }] })).toEqual([])
  })

  it('attaches metadata from the same provider fetch without loosening config-only strict discovery', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Readable, Writable } = await import('node:stream')
    const { createCodexBridgeMiddleware } = await import('./codexAppServerBridge')
    const home = await mkdtemp(join(tmpdir(), 'metadata-provider-fixture-'))
    vi.stubEnv('CODEX_HOME', home)
    vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', join(home, 'catalog.json'))
    await writeFile(join(home, 'catalog.json'), JSON.stringify({ models: [{ slug: 'cx/gpt-6-sol[1m]', context_window: 872000 }] }))
    await writeFile(join(home, 'telegram-bridge.json'), '{}')
    const rpc = vi.fn(async (method: string) => {
      if (method !== 'config/read') throw new Error(`unexpected RPC ${method}`)
      return { config: { model_provider: 'custom_endpoint', model: 'NOT_ADVERTISED', model_providers: {
        custom_endpoint: { wire_api: 'responses', base_url: 'https://fixture.invalid/v1' },
      } } }
    })
    vi.stubGlobal('__codexRemoteSharedBridge__', {
      version: 'experimental-api-v2', appServer: { rpc }, terminalManager: {}, methodCatalog: {}, telegramBridge: {}, backendQueueProcessor: {},
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: 'cx/gpt-6-sol[1m]', context_length: 872000, max_completion_tokens: 128000,
      capabilities: { tools: true, reasoning: true },
    }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    class ResponseFixture extends Writable {
      statusCode = 200
      body = ''
      setHeader() { return this }
      override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.body += chunk.toString(); callback() }
    }
    try {
      const request = Readable.from([])
      Object.assign(request, { method: 'GET', url: '/codex-api/provider-models?provider=custom_endpoint', headers: {} })
      const response = new ResponseFixture()
      await createCodexBridgeMiddleware()(request as never, response as never, vi.fn())
      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.data).toEqual(['cx/gpt-6-sol[1m]'])
      expect(body.models).toMatchObject([{ id: 'cx/gpt-6-sol[1m]', contextWindow: 872000, configuredContextWindow: 828400, reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max'] }])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(rpc).toHaveBeenCalledExactlyOnceWith('config/read', {})
    } finally {
      vi.unstubAllGlobals(); vi.unstubAllEnvs()
      await rm(home, { recursive: true, force: true })
    }
  })

})
