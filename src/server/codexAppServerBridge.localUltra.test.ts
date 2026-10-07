import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAvailableModelIds } from '../api/codexGateway'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { FREE_MODE_STATE_FILE, type FreeModeState } from './freeMode'

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

function installAppServer(rpc: (method: string, params: unknown) => Promise<unknown>, readModelCatalogSnapshot?: () => Promise<unknown>): void {
  // Use the existing shared-state seam without spawning Codex or contacting a server.
  vi.stubGlobal('__codexRemoteSharedBridge__', {
    version: 'experimental-api-v2',
    appServer: { rpc, readModelCatalogSnapshot },
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

describe('strict custom catalog metadata', () => {
  it.each([undefined, 'custom', 'custom_endpoint', 'custom-endpoint'])(
    'preserves explicit reasoning from the same fetched payload for %s without duplicate discovery', async providerId => {
      vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', '')
      await createProviderHome({ enabled: true, provider: 'custom', customBaseUrl: 'https://catalog.example.test/v1', apiKey: '', model: 'NOT_ADVERTISED' })
      const rpc = vi.fn(async () => { throw new Error('no runtime catalog means no runtime RPC') })
      installAppServer(rpc)
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [
        { id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['high', 'xhigh'], capabilities: { reasoning: true } },
        { id: 'literal-empty', supportedReasoningEfforts: [] },
        { id: 'literal-false', supportedReasoningEfforts: ['high'], capabilities: { reasoning: false } },
      ] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const response = await requestProviderModels(providerId)
      expect(response.body).toMatchObject({ data: ['cx/gpt-6.1-sol', 'literal-empty', 'literal-false'], models: [
        { id: 'cx/gpt-6.1-sol', reasoningOptions: ['high', 'xhigh'], reasoningSource: 'provider-catalog' },
        { id: 'literal-empty', reasoningOptions: [], reasoningSource: 'provider-catalog' },
        { id: 'literal-false', supportsReasoning: false, reasoningOptions: [] },
      ] })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(rpc).not.toHaveBeenCalled()
    },
  )
})

const localDescriptor = {
  slug: 'cx/gpt-6.1-sol', default_reasoning_level: 'high', supports_reasoning_effort_updates: true,
  multi_agent_version: 'v2', multi_agent_reasoning_effort: 'xhigh',
  supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }],
}
async function runtimeFixture(providerId: string | undefined, rows: unknown[], snapshotPatch: Record<string, unknown> = {}) {
  await createProviderHome({ enabled: true, provider: 'custom', customBaseUrl: 'http://127.0.0.1:20128/v1', apiKey: '', model: 'NOT_ADVERTISED', wireApi: 'responses' })
  const catalogPath = join(process.env.CODEX_HOME!, 'catalog.json')
  vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', catalogPath)
  await writeFile(catalogPath, JSON.stringify({ models: [localDescriptor] }))
  const readModelCatalogSnapshot = vi.fn(async () => ({
    config: { features: { multi_agent_v2: true }, model_provider: 'custom_endpoint', model_catalog_json: catalogPath, model_providers: {
      custom_endpoint: { wire_api: 'responses', base_url: 'http://127.0.0.1:20128/v1' },
    } },
    modelList: { data: [{ id: 'cx/gpt-6.1-sol', model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [
      { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' },
    ] }], nextCursor: null },
    customBaseUrl: 'http://127.0.0.1:20128/v1', isCurrent: () => true, customWireApi: 'responses', ...snapshotPatch,
  }))
  installAppServer(vi.fn(async () => { throw new Error('unexpected generic RPC') }), readModelCatalogSnapshot)
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: rows }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return { response: await requestProviderModels(providerId), fetchMock, readModelCatalogSnapshot, catalogPath }
}

describe('local Ultra is not provider wire metadata', () => {
  it('does not expose provider-only Ultra without a configured runtime catalog', async () => {
    vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', '')
    await createProviderHome({ enabled: true, provider: 'custom', customBaseUrl: 'http://127.0.0.1:20128/v1', apiKey: '', model: 'cx/gpt-6.1-sol' })
    const rpc = vi.fn(async () => { throw new Error('no new RPC without opt-in') })
    installAppServer(rpc)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{
      id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh', 'max', 'ultra'],
    }] }), { status: 200 })))
    const response = await requestProviderModels('custom')
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh', 'max'], reasoningSource: 'provider-catalog' }] })
    expect(rpc).not.toHaveBeenCalled()
  })
  it.each([null, 'xhigh', {}, ['xhigh', 'invalid']])('treats malformed explicit efforts %j as restrictive even with a runtime Ultra descriptor', async efforts => {
    const { response } = await runtimeFixture('custom_endpoint', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: efforts }])
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: [], reasoningSource: 'provider-catalog' }] })
  })
})


describe('legacy-thread Ultra requires effective runtime v2', () => {
  it.each([undefined, {}, { multi_agent_v2: false }, { multi_agent_v2: null }, { multi_agent_v2: 'true' }, null])(
    'excludes Ultra when actual config features are absent, false or malformed: %j', async features => {
      // The catalog and actual model/list both advertise Ultra, but neither proves a
      // resumed v1 thread uses v2. A menu opt-in env is not effective runtime evidence.
      vi.stubEnv('CODEXUI_MULTI_AGENT_V2', 'true')
      const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh', 'max'] }])
      const config = { model_provider: 'custom_endpoint', model_catalog_json: catalogPath, features, model_providers: {
        custom_endpoint: { wire_api: 'responses', base_url: 'http://127.0.0.1:20128/v1' },
      } }
      installAppServer(vi.fn(async () => { throw new Error('unexpected generic RPC') }), vi.fn(async () => ({
        config, customBaseUrl: 'http://127.0.0.1:20128/v1', customWireApi: 'responses', isCurrent: () => true,
        modelList: { data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [
          { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' },
        ] }], nextCursor: null },
      })))
      const response = await requestProviderModels('custom_endpoint')
      expect(response.body).toMatchObject({ models: [{
        reasoningOptions: ['xhigh', 'max'], reasoningSource: 'provider-catalog',
      }] })
    },
  )
})

describe('runtime Ultra provider identity', () => {
  it.each([
    ['audit-provider', 'audit_provider'], ['audit_provider', 'audit-provider'],
    ['AuditProvider', 'auditprovider'], ['auditprovider', 'AuditProvider'],
  ])('does not canonicalize arbitrary provider %s into %s', async (requested, effective) => {
    const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }])
    await writeFile(join(process.env.CODEX_HOME!, FREE_MODE_STATE_FILE), JSON.stringify({ enabled: false, provider: 'codex', apiKey: 'fixture-not-a-secret', model: 'NOT_ADVERTISED' }))
    const fetchedConfig = { model_provider: requested, model_catalog_json: catalogPath, model_providers: {
      [requested]: { base_url: 'http://127.0.0.1:20128/v1', wire_api: 'responses' },
      [effective]: { base_url: 'https://unrelated.example.test/v1', wire_api: 'responses' },
    } }
    const runtimeConfig = { ...fetchedConfig, features: { multi_agent_v2: true }, model_provider: effective, model_providers: {
      [effective]: { base_url: 'http://127.0.0.1:20128/v1', wire_api: 'responses' },
      [requested]: { base_url: 'https://unrelated.example.test/v1', wire_api: 'responses' },
    } }
    installAppServer(vi.fn(async () => ({ config: fetchedConfig })), vi.fn(async () => ({ config: runtimeConfig, customBaseUrl: '', isCurrent: () => true, modelList: {
      data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }] }], nextCursor: null,
    } })))
    const response = await requestProviderModels(requested)
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })

  it.each(['custom', 'custom_endpoint', 'custom-endpoint', ' Custom ', 'CUSTOM_ENDPOINT', ' Custom-EndPoint '])(
    'canonicalizes only the explicitly supported custom alias %s', async effective => {
      const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }])
      installAppServer(vi.fn(async () => { throw new Error('unexpected generic RPC') }), vi.fn(async () => ({
        config: { features: { multi_agent_v2: true }, model_provider: effective, model_catalog_json: catalogPath, model_providers: {
          [effective]: { base_url: 'http://127.0.0.1:20128/v1', wire_api: 'responses' },
        } }, customBaseUrl: 'http://127.0.0.1:20128/v1', customWireApi: 'responses', isCurrent: () => true,
        modelList: { data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }] }], nextCursor: null },
      })))
      const response = await requestProviderModels('custom_endpoint')
      expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh', 'ultra'], reasoningSource: 'codex-runtime-catalog' }] })
    },
  )
})

describe('runtime Ultra restrictive boundaries', () => {
  it.each([
    { id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [] },
    { id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['high', 'max'] },
    { id: 'cx/gpt-6.1-sol', capabilities: { reasoning: false }, supportedReasoningEfforts: ['xhigh'] },
    { id: 'cx/gpt-6.1-sol', thinkingLevels: [], supportedReasoningEfforts: ['xhigh'] },
  ])('retains restrictive upstream effort declarations %j', async row => {
    const { response, readModelCatalogSnapshot } = await runtimeFixture('custom', [row])
    expect((response.body as { models: Array<{ reasoningOptions: string[] }> }).models[0]!.reasoningOptions).not.toContain('ultra')
    expect(readModelCatalogSnapshot).not.toHaveBeenCalled()
  })
  it.each([
    { config: { model_provider: 'openai' } },
    { config: { model_provider: 'custom_endpoint', model_catalog_json: '/stale' } },
    { customBaseUrl: 'http://other.example.test/v1' },
    { isCurrent: () => false },
    { modelList: { data: [] } },
    { modelList: { data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }] }] } },
    { modelList: { data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [] }] } },
  ])('rejects unconfirmed runtime or endpoint identity %j', async mismatch => {
    const { response } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }], mismatch)
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })
  it('rejects malformed actual runtime model/list effort rows', async () => {
    const { response } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }], {
      modelList: { data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [
        { reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'invalid' },
      ] }], nextCursor: null },
    })
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })
  it('allows separately audited route binding when effort metadata is absent, not generic thinking flag false', async () => {
    const { response } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', capabilities: { thinkingEffortSupported: false } }])
    // Native/runtime evidence replaces family fallback; this exact fixture has no low/medium.
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['high', 'xhigh', 'max', 'ultra'], reasoningSource: 'codex-runtime-catalog' }] })
  })
})

describe('configured runtime local delegation provenance', () => {

  it('never enables Ultra if the configured descriptor file changes while runtime evidence is awaited', async () => {
    const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }])
    const config = { features: { multi_agent_v2: true }, model_provider: 'custom_endpoint', model_catalog_json: catalogPath, model_providers: {
      custom_endpoint: { base_url: 'http://127.0.0.1:20128/v1', wire_api: 'responses' },
    } }
    installAppServer(vi.fn(async () => ({ config })), vi.fn(async () => {
      await writeFile(catalogPath, JSON.stringify({ models: [{ ...localDescriptor, multi_agent_version: 'v1' }] }))
      return { config, customBaseUrl: 'http://127.0.0.1:20128/v1', customWireApi: 'responses', isCurrent: () => true,
        modelList: { data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }] }], nextCursor: null } }
    }))
    const response = await requestProviderModels('custom')
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })


  it('does not borrow audited Responses Ultra support for a custom chat-completions route', async () => {
    const { response } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }], { customWireApi: 'chat' })
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })
  it('restricts an explicitly non-reasoning configured native descriptor', async () => {
    const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }])
    await writeFile(catalogPath, JSON.stringify({ models: [{ ...localDescriptor, capabilities: { reasoning: false } }] }))
    const response = await requestProviderModels('custom')
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })


  it.skipIf(!process.env.CODEXUI_TEST_RUNTIME_SNAPSHOT)('uses real pinned app-server model/list/config readback for the generated candidate catalog', async () => {
    const snapshot = JSON.parse(await (await import('node:fs/promises')).readFile(process.env.CODEXUI_TEST_RUNTIME_SNAPSHOT!, 'utf8'))
    const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh', 'max'] }])
    snapshot.isCurrent = () => true
    snapshot.customWireApi = 'responses'
    expect(snapshot.config.features?.multi_agent_v2, 'actual pinned config/read must confirm the legacy-thread v2 override').toBe(true)
    const actualCatalog = snapshot.config.model_catalog_json
    vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', actualCatalog)
    installAppServer(vi.fn(async () => { throw new Error('no generic RPC') }), vi.fn(async () => snapshot))
    const response = await requestProviderModels('custom_endpoint')
    expect(response.body).toMatchObject({ data: ['cx/gpt-6.1-sol'], models: [{ reasoningOptions: ['xhigh', 'max', 'ultra'], reasoningSource: 'codex-runtime-catalog' }] })
    expect(actualCatalog).not.toBe(catalogPath)
  })


  it.each([undefined, 'custom', 'custom_endpoint', 'custom-endpoint'])(
    'config-only custom metadata uses the same normalized payload and runtime provenance for %s', async providerId => {
      const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh', 'max'] }])
      await writeFile(join(process.env.CODEX_HOME!, FREE_MODE_STATE_FILE), JSON.stringify({ enabled: false, provider: 'codex', apiKey: '', model: 'NOT_ADVERTISED' }))
      const config = { features: { multi_agent_v2: true }, model_provider: 'custom_endpoint', model_catalog_json: catalogPath, model_providers: {
        custom_endpoint: { base_url: 'http://127.0.0.1:20128/v1', wire_api: 'responses' },
      } }
      installAppServer(vi.fn(async () => ({ config })), vi.fn(async () => ({ config, customBaseUrl: '', isCurrent: () => true, modelList: {
        data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] }], nextCursor: null,
      } })))
      const response = await requestProviderModels(providerId)
      expect(response.body).toMatchObject({ data: ['cx/gpt-6.1-sol'], models: [{ reasoningOptions: ['xhigh', 'max', 'ultra'], reasoningSource: 'codex-runtime-catalog' }] })
    },
  )


  it('does not transfer fetched config-only effort support across a same-provider endpoint change', async () => {
    const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }])
    await writeFile(join(process.env.CODEX_HOME!, FREE_MODE_STATE_FILE), JSON.stringify({ enabled: false, provider: 'codex', apiKey: '', model: 'NOT_ADVERTISED' }))
    const config = { features: { multi_agent_v2: true }, model_provider: 'custom_endpoint', model_catalog_json: catalogPath, model_providers: {
      custom_endpoint: { base_url: 'https://old.example.test/v1', wire_api: 'responses' },
    } }
    const effectiveConfig = { ...config, model_providers: { custom_endpoint: { base_url: 'http://127.0.0.1:20128/v1', wire_api: 'responses' } } }
    installAppServer(vi.fn(async () => ({ config })), vi.fn(async () => ({ config: effectiveConfig, customBaseUrl: '', isCurrent: () => true, modelList: {
      data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }] }], nextCursor: null,
    } })))
    const response = await requestProviderModels('custom_endpoint')
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })


  it('does not bleed config-only runtime Ultra from NineRouter into requested custom aliases', async () => {
    const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }])
    await writeFile(join(process.env.CODEX_HOME!, FREE_MODE_STATE_FILE), JSON.stringify({ enabled: false, provider: 'codex', apiKey: '', model: 'NOT_ADVERTISED' }))
    const config = { features: { multi_agent_v2: true }, model_provider: 'ninerouter', model_catalog_json: catalogPath, model_providers: {
      ninerouter: { base_url: 'http://127.0.0.1:20128/v1', wire_api: 'responses' },
    } }
    installAppServer(vi.fn(async () => ({ config })), vi.fn(async () => ({ config, customBaseUrl: '', isCurrent: () => true, modelList: {
      data: [{ model: 'cx/gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }] }], nextCursor: null,
    } })))
    const response = await requestProviderModels('custom_endpoint')
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })


  it('rejects malformed runtime descriptor efforts rather than trusting a filename plus matching tokens', async () => {
    const { catalogPath } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }])
    await writeFile(catalogPath, JSON.stringify({ models: [{ ...localDescriptor, supported_reasoning_levels: [
      { effort: 'xhigh' }, { effort: 'ultra' }, { effort: 'invalid' },
    ] }] }))
    const response = await requestProviderModels('custom')
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })
  it('respects row-level explicit reasoning=false even if nested provider reasoning is true', async () => {
    const { response } = await runtimeFixture('custom', [{ id: 'cx/gpt-6.1-sol', reasoning: false, capabilities: { reasoning: true }, supportedReasoningEfforts: ['xhigh'] }])
    expect(response.body).toMatchObject({ models: [{ supportsReasoning: false, reasoningOptions: [] }] })
  })

  it.each([undefined, 'custom', 'custom_endpoint', 'custom-endpoint'])(
    'exposes exact local Ultra only from confirmed runtime model/list for %s', async providerId => {
      const { response, fetchMock, readModelCatalogSnapshot } = await runtimeFixture(providerId, [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['high', 'xhigh', 'max'] }])
      expect(response.body).toMatchObject({ data: ['cx/gpt-6.1-sol'], models: [{
        id: 'cx/gpt-6.1-sol', reasoningOptions: ['high', 'xhigh', 'max', 'ultra'], reasoningSource: 'codex-runtime-catalog',
      }] })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(readModelCatalogSnapshot).toHaveBeenCalledTimes(1)
    },
  )
})

async function multiRuntimeFixture(descriptors: Record<string, unknown>[], rows: unknown[], runtimePatch: Record<string, unknown> = {}) {
  const { catalogPath } = await runtimeFixture('custom', [])
  await writeFile(catalogPath, JSON.stringify({ models: descriptors }))
  const readModelCatalogSnapshot = vi.fn(async () => ({
    config: { features: { multi_agent_v2: true }, model_provider: 'custom_endpoint', model_catalog_json: catalogPath,
      model_providers: { custom_endpoint: { wire_api: 'responses', base_url: 'http://127.0.0.1:20128/v1' } } },
    customBaseUrl: 'http://127.0.0.1:20128/v1', customWireApi: 'responses', isCurrent: () => true,
    modelList: { data: descriptors.map(model => ({ model: model.slug,
      supportedReasoningEfforts: (model.supported_reasoning_levels as { effort: string }[]).map(level => ({ reasoningEffort: level.effort })) })), nextCursor: null },
    ...runtimePatch,
  }))
  installAppServer(vi.fn(async () => { throw new Error('no per-model generic RPC') }), readModelCatalogSnapshot)
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: rows }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return { response: await requestProviderModels('custom'), readModelCatalogSnapshot, fetchMock, catalogPath }
}

const validLocalDescriptor = (slug: string, patch: Record<string, unknown> = {}) => ({
  ...localDescriptor, slug, default_reasoning_level: 'high', ...patch,
})

describe('all audited native local Ultra models', () => {
  it.each(['cx/gpt-6-astra', 'cx/gpt-6-astra[1m]'])(
    'retains distinct native Max and Ultra instead of the legacy Astra fallback for %s', async id => {
      const { response, readModelCatalogSnapshot, fetchMock } = await multiRuntimeFixture([
        validLocalDescriptor(id),
      ], [{ id }])
      expect(response.body).toMatchObject({ models: [{
        id, reasoningOptions: ['high', 'xhigh', 'max', 'ultra'], reasoningSource: 'codex-runtime-catalog',
      }] })
      expect(readModelCatalogSnapshot).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )
  it.each(['cx/gpt-6-sol[1m]', 'cx/gpt-5.6-sol-review', 'cx/gpt-5.6-terra-review'])(
    'does not fallback from native wire Max to provider-only xhigh on %s', async id => {
      const { response, readModelCatalogSnapshot } = await multiRuntimeFixture([validLocalDescriptor(id, { multi_agent_reasoning_effort: null })],
        [{ id, supportedReasoningEfforts: ['xhigh', 'ultra'] }])
      expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
      expect(readModelCatalogSnapshot).not.toHaveBeenCalled()
    },
  )
  it('denies duplicate runtime exact IDs without denying an independently confirmed model', async () => {
    const row = { model: 'cx/gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }] }
    const { response } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6.1-sol'), validLocalDescriptor('cx/gpt-6-astra')],
      [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }, { id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh'] }], {
        modelList: { data: [{ ...row, model: 'cx/gpt-6.1-sol' }, row, row], nextCursor: null },
      })
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh', 'ultra'] }, { reasoningOptions: ['xhigh'] }] })
  })
  it('fails closed for duplicate provider rows rather than trusting the first exact positive row', async () => {
    const { response, readModelCatalogSnapshot } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6-astra')], [
      { id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh'] },
      { id: 'cx/gpt-6-astra', reasoning: false },
    ])
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: [], reasoningSource: 'provider-catalog' }] })
    expect(readModelCatalogSnapshot).not.toHaveBeenCalled()
  })
  it('enables only six proven literal one-million and review aliases in one snapshot', async () => {
    const ids = ['cx/gpt-6-astra[1m]', 'cx/gpt-6-sol[1m]', 'cx/gpt-5.6-sol[1m]', 'cx/gpt-5.6-sol-review', 'cx/gpt-5.6-terra[1m]', 'cx/gpt-5.6-terra-review']
    const descriptors = ids.map(slug => validLocalDescriptor(slug, { multi_agent_reasoning_effort: slug === 'cx/gpt-6-astra[1m]' ? 'xhigh' : null }))
    const { response, readModelCatalogSnapshot } = await multiRuntimeFixture(descriptors,
      ids.map(id => ({ id, supportedReasoningEfforts: [id === 'cx/gpt-6-astra[1m]' ? 'xhigh' : 'max'] })))
    const models = (response.body as { models: { id: string; reasoningOptions: string[] }[] }).models
    expect(models.filter(model => model.reasoningOptions.includes('ultra')).map(model => model.id)).toEqual(ids)
    expect(readModelCatalogSnapshot).toHaveBeenCalledTimes(1)
  })
  it.skipIf(!process.env.CODEXUI_TEST_RUNTIME_SNAPSHOT || !process.env.CODEXUI_TEST_GATEWAY_CATALOG)(
    'reads all exact audited modes from actual pinned CLI model/list and effective config in one snapshot', async () => {
      const fs = await import('node:fs/promises')
      const snapshot = JSON.parse(await fs.readFile(process.env.CODEXUI_TEST_RUNTIME_SNAPSHOT!, 'utf8'))
      const advertised = JSON.parse(await fs.readFile(process.env.CODEXUI_TEST_GATEWAY_CATALOG!, 'utf8'))
      await createProviderHome({ enabled: true, provider: 'custom', customBaseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'dummy', model: 'NOT_ADVERTISED', wireApi: 'responses' })
      vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', snapshot.config.model_catalog_json)
      snapshot.isCurrent = () => true
      snapshot.customWireApi = 'responses'
      const readModelCatalogSnapshot = vi.fn(async () => snapshot)
      installAppServer(vi.fn(async () => { throw new Error('no generic RPC') }), readModelCatalogSnapshot)
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify(advertised), { status: 200 })))
      const response = await requestProviderModels('custom_endpoint')
      const models = (response.body as { models: { id: string; reasoningOptions: string[]; reasoningSource?: string }[] }).models
      const native = JSON.parse(await fs.readFile(snapshot.config.model_catalog_json, 'utf8'))
      const expected = native.models.filter((model: any) => model.slug.startsWith('cx/') && model.supported_reasoning_levels.some((level: any) => level.effort === 'ultra')).map((model: any) => model.slug)
      expect(models.filter(model => model.reasoningOptions.includes('ultra')).map(model => model.id)).toEqual(expected)
      expect(models.filter(model => expected.includes(model.id)).every(model => model.reasoningSource === 'codex-runtime-catalog')).toBe(true)
      expect(expected.length).toBeGreaterThan(1)
      expect(readModelCatalogSnapshot).toHaveBeenCalledTimes(1)
    },
  )
  it('rejects malformed runtime model/list strings even if provider metadata permits them', async () => {
    const { response } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6-astra')],
      [{ id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh'] }], {
        modelList: { data: [{ model: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh', { reasoningEffort: 'ultra' }] }] },
      })
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })
  it.each([
    { reasoning: false }, { capabilities: { reasoning: false } }, { multi_agent_version: 'v1' },
    { supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }] },
    { supported_reasoning_levels: [{ effort: 'xhigh' }, { effort: 'ultra' }, { effort: 'invalid' }] },
  ])('denies restrictive or malformed second-model native metadata %j', async patch => {
    const { response } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6-astra', patch)],
      [{ id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh', 'ultra'] }])
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })
  it('denies duplicate native IDs locally without poisoning an unrelated exact descriptor', async () => {
    const d = validLocalDescriptor('cx/gpt-6-astra')
    const { response } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6.1-sol'), d, d],
      [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }, { id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh'] }])
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh', 'ultra'] }, { reasoningOptions: ['xhigh'] }] })
  })
  it.each([
    { supportedReasoningEfforts: [] }, { supportedReasoningEfforts: false }, { thinkingLevels: [] },
    { thinkingLevels: ['max'] }, { supported_reasoning_efforts: ['invalid'] }, { reasoning: false },
  ])('intersects every explicit provider restriction on second model %j', async patch => {
    const { response, readModelCatalogSnapshot } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6-astra')],
      [{ id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh', 'ultra'], ...patch }])
    expect((response.body as { models: { reasoningOptions: string[] }[] }).models[0]!.reasoningOptions).not.toContain('ultra')
    expect(readModelCatalogSnapshot).not.toHaveBeenCalled()
  })
  it.each([
    { config: { features: { multi_agent_v2: false } } }, { isCurrent: () => false },
    { customBaseUrl: 'http://other.invalid/v1' }, { customWireApi: 'chat' }, { config: { model_provider: 'openai' } },
  ])('rejects second-model runtime generation or endpoint mismatch %j', async patch => {
    const { response } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6-astra')],
      [{ id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh'] }], patch)
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' }] })
  })
  it('rejects malformed native multi-agent effort instead of silently invoking fallback', async () => {
    const { response } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6.1-sol', { multi_agent_reasoning_effort: {} })],
      [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['max'] }])
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['max'], reasoningSource: 'provider-catalog' }] })
  })
  it('withholds unbound variant provider-only Ultra until a literal route manifest is audited', async () => {
    const { response, readModelCatalogSnapshot } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6.1-sol[1m]')],
      [{ id: 'cx/gpt-6.1-sol[1m]', supportedReasoningEfforts: ['max', 'ultra'] }])
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['max'], reasoningSource: 'provider-catalog' }] })
    expect(readModelCatalogSnapshot).not.toHaveBeenCalled()
  })
  it('denies malformed native defaults per model while retaining other eligible local modes', async () => {
    const { response } = await multiRuntimeFixture([
      validLocalDescriptor('cx/gpt-6.1-sol'), validLocalDescriptor('cx/gpt-6-astra', { default_reasoning_level: 'not-supported' }),
    ], [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }, { id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh'] }])
    expect(response.body).toMatchObject({ models: [
      { reasoningOptions: ['xhigh', 'ultra'] }, { reasoningOptions: ['xhigh'], reasoningSource: 'provider-catalog' },
    ] })
  })
  it.each(['cx/gpt-5.6-sol', 'cx/gpt-5.6-terra'])('supports native literal Ultra selection despite false update flag on %s', async slug => {
    const { response } = await multiRuntimeFixture([validLocalDescriptor(slug, { supports_reasoning_effort_updates: false, multi_agent_reasoning_effort: null })],
      [{ id: slug, supportedReasoningEfforts: ['max'] }])
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['max', 'ultra'], reasoningSource: 'codex-runtime-catalog' }] })
  })
  it('uses native Max CLI fallback instead of requiring xhigh for the exact Sol 6 route', async () => {
    const { response } = await multiRuntimeFixture([validLocalDescriptor('cx/gpt-6-sol', { multi_agent_reasoning_effort: null })],
      [{ id: 'cx/gpt-6-sol', supportedReasoningEfforts: ['max'] }])
    expect(response.body).toMatchObject({ models: [{ reasoningOptions: ['max', 'ultra'], reasoningSource: 'codex-runtime-catalog' }] })
  })
  it('enables a second exact native Astra descriptor with a single shared runtime snapshot', async () => {
    const { response, readModelCatalogSnapshot, fetchMock } = await multiRuntimeFixture([
      validLocalDescriptor('cx/gpt-6.1-sol'), validLocalDescriptor('cx/gpt-6-astra'),
    ], [{ id: 'cx/gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }, { id: 'cx/gpt-6-astra', supportedReasoningEfforts: ['xhigh'] }])
    expect(response.body).toMatchObject({ models: [
      { id: 'cx/gpt-6.1-sol', reasoningOptions: ['xhigh', 'ultra'], reasoningSource: 'codex-runtime-catalog' },
      { id: 'cx/gpt-6-astra', reasoningOptions: ['xhigh', 'ultra'], reasoningSource: 'codex-runtime-catalog' },
    ] })
    expect(readModelCatalogSnapshot).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
