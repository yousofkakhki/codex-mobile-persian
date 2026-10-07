import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAvailableModelIds } from '../api/codexGateway'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { FREE_MODE_STATE_FILE, type FreeModeState } from './freeMode'
import { normalizeProviderModelMetadata } from './providerModelMetadata'

const tempDirs: string[] = []

class TestResponse extends Writable {
  statusCode = 200
  readonly headers = new Map<string, string>()
  body = ''

  setHeader(name: string, value: string): this {
    this.headers.set(name, value)
    return this
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.body += chunk.toString('utf8')
    callback()
  }
}

async function createProviderHome(state: FreeModeState): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codexui-provider-model-alias-'))
  tempDirs.push(codexHome)
  vi.stubEnv('CODEX_HOME', codexHome)
  await writeFile(join(codexHome, FREE_MODE_STATE_FILE), JSON.stringify(state), 'utf8')
  await writeFile(join(codexHome, 'telegram-bridge.json'), '{}', 'utf8')
}

function installAppServer(rpc: (method: string, params: unknown) => Promise<unknown>): void {
  // Use the existing shared-state seam without spawning Codex or contacting a server.
  vi.stubGlobal('__codexRemoteSharedBridge__', {
    version: 'experimental-api-v2',
    appServer: { rpc },
    terminalManager: {},
    methodCatalog: {},
    telegramBridge: {},
    backendQueueProcessor: {},
  })
}

async function requestProviderModels(providerId?: string): Promise<{ status: number; body: unknown }> {
  const response = new TestResponse()
  const request = {
    method: 'GET',
    url: providerId === undefined
      ? '/codex-api/provider-models'
      : `/codex-api/provider-models?provider=${encodeURIComponent(providerId)}`,
    headers: {},
  } as IncomingMessage
  const next = vi.fn()
  await createCodexBridgeMiddleware()(request, response as unknown as ServerResponse, next)
  expect(next).not.toHaveBeenCalled()
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('provider models route custom aliases', () => {
  it.each(['custom', 'custom_endpoint', 'custom-endpoint'].flatMap(providerId => [
    { providerId, scenario: 'upstream-only', status: 200, payload: { data: [{ id: 'upstream-model' }] }, expected: ['upstream-model'] },
    { providerId, scenario: 'upstream-502', status: 502, payload: { error: 'fixture upstream unavailable' }, expected: [] },
    { providerId, scenario: 'empty-upstream', status: 200, payload: { data: [] }, expected: [] },
    { providerId, scenario: 'advertised-literal', status: 200, payload: { data: [{ id: 'Ggh' }, { id: 'upstream-model' }] }, expected: ['Ggh', 'upstream-model'] },
  ]))(
    'requires an upstream config-only catalog for $providerId $scenario without inventing configured Ggh',
    async ({ providerId, status, payload, expected }) => {
      await createProviderHome({ enabled: false, provider: 'codex', apiKey: '', model: 'Ggh' })
      const config = {
        model_provider: providerId,
        model: 'Ggh',
        model_providers: { [providerId]: { wire_api: 'responses', base_url: 'https://config-only.example.test/v1' } },
      }
      const configBefore = JSON.stringify(config)
      const rpc = vi.fn(async () => ({ config }))
      installAppServer(rpc)
      const fetchMock = vi.fn<typeof fetch>(async (input): Promise<Response> => {
        if (String(input).startsWith('/codex-api/provider-models')) {
          const response = await requestProviderModels(providerId)
          return new Response(JSON.stringify(response.body), { status: response.status })
        }
        return new Response(JSON.stringify(payload), { status })
      })
      vi.stubGlobal('fetch', fetchMock)
      const response = await requestProviderModels(providerId)
      expect(response.body).toMatchObject({ data: expected, exclusive: true })
      if (expected.length) {
        await expect(getAvailableModelIds({ requireProviderModels: true, providerId })).resolves.toEqual(expected)
      } else {
        await expect(getAvailableModelIds({ requireProviderModels: true, providerId })).rejects.toThrow(/catalog|models/i)
      }
      expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://')).map(([url]) => String(url))).toEqual([
        'https://config-only.example.test/v1/models', 'https://config-only.example.test/v1/models',
      ])
      expect(JSON.stringify(config)).toBe(configBefore)
      expect(config.model).toBe('Ggh')
    },
  )
  it.each(['custom', 'custom_endpoint', 'custom-endpoint', ' CUSTOM ', ' CuStOm_EnDpOiNt '])(
    'discovers upstream custom models for %s without reading app-server config',
    async (providerId) => {
      await createProviderHome({
        enabled: true,
        provider: 'custom',
        customBaseUrl: 'https://custom-provider.example.test/v1',
        apiKey: null,
        model: 'Ggh',
        wireApi: 'responses',
      })
      const rpc = vi.fn(async () => {
        throw new Error('custom model discovery must not call config/read')
      })
      installAppServer(rpc)
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        data: [{ id: 'cx/gpt-supported' }, { id: 'upstream-model' }],
      }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(requestProviderModels(providerId)).resolves.toEqual({
        status: 200,
        body: {
          data: ['cx/gpt-supported', 'upstream-model'],
          models: normalizeProviderModelMetadata({ data: [{ id: 'cx/gpt-supported' }, { id: 'upstream-model' }] }).map(model => ({ ...model, discoveredAt: expect.any(String) })),
          providerId: 'custom_endpoint',
          source: 'custom',
          exclusive: true,
        },
      })
      expect(rpc).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://custom-provider.example.test/v1/models')
    },
  )

  it.each(['custom', 'custom_endpoint', 'custom-endpoint'])(
    'returns an empty custom catalog for %s after discovery fails without calling config/read',
    async (providerId) => {
      await createProviderHome({
        enabled: true,
        provider: 'custom',
        customBaseUrl: 'https://custom-provider.example.test/v1',
        apiKey: null,
        model: 'Ggh',
      })
      const rpc = vi.fn(async () => {
        throw new Error('custom model discovery must not call config/read')
      })
      installAppServer(rpc)
      const fetchMock = vi.fn<typeof fetch>(async () => {
        throw new Error('fixture discovery failed')
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(requestProviderModels(providerId)).resolves.toEqual({
        status: 200,
        body: { data: [], providerId: 'custom_endpoint', source: 'custom', exclusive: true },
      })
      expect(rpc).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it.each([undefined, 'custom', 'custom_endpoint', 'custom-endpoint'])(
    'preserves the literal configured model when returned by upstream for %s',
    async (providerId) => {
      await createProviderHome({
        enabled: true,
        provider: 'custom',
        customBaseUrl: 'https://custom-provider.example.test/v1',
        apiKey: null,
        model: 'Ggh',
      })
      const rpc = vi.fn(async () => {
        throw new Error('custom model discovery must not call config/read')
      })
      installAppServer(rpc)
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        data: [{ id: 'Ggh' }, { id: 'upstream-model' }],
      }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const response = await requestProviderModels(providerId)
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        data: ['Ggh', 'upstream-model'], source: 'custom', exclusive: true,
      })
      expect(rpc).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('does not inject the absent configured model into no-query custom discovery', async () => {
    await createProviderHome({
      enabled: true,
      provider: 'custom',
      customBaseUrl: 'https://custom-provider.example.test/v1',
      apiKey: null,
      model: 'Ggh',
    })
    const rpc = vi.fn(async () => {
      throw new Error('custom model discovery must not call config/read')
    })
    installAppServer(rpc)
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'upstream-model' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestProviderModels()).resolves.toEqual({
      status: 200,
      body: { data: ['upstream-model'], models: normalizeProviderModelMetadata({ data: [{ id: 'upstream-model' }] }).map(model => ({ ...model, discoveredAt: expect.any(String) })), source: 'custom', exclusive: true },
    })
    expect(rpc).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retains config-backed discovery for a non-custom provider', async () => {
    await createProviderHome({ enabled: false, provider: 'codex', apiKey: null, model: 'Ggh' })
    const rpc = vi.fn(async () => ({
      config: {
        model_provider: 'fixture-provider',
        model: 'Ggh',
        model_providers: {
          'fixture-provider': { wire_api: 'responses', base_url: 'https://provider.example.test/v1' },
        },
      },
    }))
    installAppServer(rpc)
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'upstream-model' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    // Characterize existing config-backed injection; data is not a pure upstream catalog here.
    const response = await requestProviderModels('fixture-provider')
    expect(response).toMatchObject({
      status: 200,
      body: {
        data: ['Ggh', 'upstream-model'], providerId: 'fixture-provider', source: 'provider', exclusive: true,
        models: [{ id: 'upstream-model', upstreamApi: 'responses', routingSource: 'provider-catalog' }],
      },
    })
    expect((response.body as { models: Array<{ id: string }> }).models.map(model => model.id)).toEqual(['upstream-model'])
    expect(rpc).toHaveBeenCalledExactlyOnceWith('config/read', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://provider.example.test/v1/models')
  })

  it.each(['custom', 'custom_endpoint', 'custom-endpoint'])(
    'rejects configured-model fallback for %s when no custom endpoint is configured',
    async (providerId) => {
      await createProviderHome({ enabled: false, provider: 'codex', apiKey: null, model: 'Ggh' })
      const rpc = vi.fn(async () => ({
        config: {
          model_provider: 'fixture-provider',
          model: 'Ggh',
          model_providers: { 'fixture-provider': { wire_api: 'chat' } },
        },
      }))
      installAppServer(rpc)
      const fetchMock = vi.fn<typeof fetch>()
      vi.stubGlobal('fetch', fetchMock)

      await expect(requestProviderModels(providerId)).resolves.toEqual({
        status: 200,
        body: { data: [], providerId: 'fixture-provider', source: 'provider', exclusive: true },
      })
      expect(rpc).toHaveBeenCalledExactlyOnceWith('config/read', {})
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})
