import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendQueueProcessor, callRpcWithArchiveRecovery, createCodexBridgeMiddleware } from './codexAppServerBridge'
import { FREE_MODE_STATE_FILE } from './freeMode'

const tempDirs: string[] = []
const processors: BackendQueueProcessor[] = []
const queuedMessage = {
  id: 'queued-fixture',
  text: 'queued fixture prompt',
  imageUrls: [],
  skills: [],
  fileAttachments: [],
  collaborationMode: 'default',
}

async function createQueueHome(threadId = 'old-provider-thread'): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codexui-global-provider-routing-'))
  tempDirs.push(home)
  vi.stubEnv('CODEX_HOME', home)
  await writeFile(join(home, '.codex-global-state.json'), JSON.stringify({
    'thread-queue-state': { [threadId]: [queuedMessage] },
  }), 'utf8')
  return home
}

function createProcessor(rpc: (method: string, params: unknown) => Promise<unknown>): BackendQueueProcessor {
  vi.useFakeTimers()
  const processor = new BackendQueueProcessor({ rpc, onNotification: () => () => undefined } as never)
  processors.push(processor)
  return processor
}

async function readSavedQueue(home: string): Promise<unknown> {
  const state = JSON.parse(await readFile(join(home, '.codex-global-state.json'), 'utf8'))
  return state['thread-queue-state']
}

afterEach(async () => {
  for (const processor of processors.splice(0)) processor.dispose()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('global provider routing for backend queued turns', () => {
  it('prefers the actual custom catalog endpoint over a stale free-mode discovery target', async () => {
    const home = await createQueueHome()
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({
      enabled: true, provider: 'custom', customBaseUrl: 'https://stale.example.test/v1', apiKey: '', model: 'Ggh',
    }), 'utf8')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'cx/actual' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: {
        model_provider: 'custom_endpoint', model: 'Ggh', model_providers: {
          custom_endpoint: { base_url: 'https://actual.example.test/v1', wire_api: 'responses' },
        },
      } }
      if (method === 'thread/resume') return { modelProvider: 'custom_endpoint', thread: { turns: [] } }
      if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
      throw new Error(`unexpected RPC: ${method}`)
    })

    await createProcessor(rpc).processThreadQueue('old-provider-thread')

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://actual.example.test/v1/models')
    expect(rpc.mock.calls.filter(([method]) => method === 'config/read')).toHaveLength(1)
  })

  it('preserves a literal configured custom model advertised by the catalog', async () => {
    const home = await createQueueHome()
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({
      enabled: true, provider: 'custom', customBaseUrl: 'https://fixture.example.test/v1', apiKey: '', model: 'Ggh',
    }), 'utf8')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'cx/first' }, { id: 'Ggh' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: { model_provider: 'custom_endpoint', model: 'Ggh' } }
      if (method === 'thread/resume') return { modelProvider: 'custom_endpoint', thread: { turns: [] } }
      if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
      throw new Error(`unexpected RPC: ${method}`)
    })

    await createProcessor(rpc).processThreadQueue('old-provider-thread')

    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'old-provider-thread', modelProvider: 'custom_endpoint', model: 'Ggh', excludeTurns: true,
    })
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: 'Ggh' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['empty', 'failure'])('keeps a queued message when custom discovery is %s instead of using stale native models', async (condition) => {
    const home = await createQueueHome()
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({
      enabled: true, provider: 'custom', customBaseUrl: 'https://fixture.example.test/v1', apiKey: '', model: 'Ggh',
    }), 'utf8')
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (condition === 'failure') throw new Error('fixture catalog offline')
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: { model_provider: 'custom_endpoint', model: 'Ggh' } }
      throw new Error(`unexpected RPC: ${method}`)
    })

    await createProcessor(rpc).processThreadQueue('old-provider-thread')

    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['thread/read', 'config/read'])
    expect(await readSavedQueue(home)).toEqual({ 'old-provider-thread': [queuedMessage] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent queue drains into one provider resume and one turn/start', async () => {
    const home = await createQueueHome()
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: { model_provider: 'Exact_Provider_ID', model: 'cx/current' } }
      if (method === 'thread/resume') return { modelProvider: 'Exact_Provider_ID', thread: { turns: [] } }
      if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const processor = createProcessor(rpc)

    await Promise.all([processor.processThreadQueue('old-provider-thread'), processor.processThreadQueue('old-provider-thread')])

    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['thread/read', 'config/read', 'thread/resume', 'turn/start'])
    expect(await readSavedQueue(home)).toBeUndefined()
  })

  it.each(['inProgress', 'running', 'active'])('leaves active writer %s untouched', async (status) => {
    const home = await createQueueHome()
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: status }, turns: [] } }
      throw new Error(`unexpected RPC: ${method}`)
    })

    await createProcessor(rpc).processThreadQueue('old-provider-thread')

    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['thread/read'])
    expect(await readSavedQueue(home)).toEqual({ 'old-provider-thread': [queuedMessage] })
  })

  it('discovers models from a config-only custom endpoint without injecting the configured token', async () => {
    const home = await createQueueHome()
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'cx/config-only-advertised' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: {
        model_provider: 'custom_endpoint', model: 'Ggh', model_providers: {
          custom_endpoint: { base_url: 'https://config-only.example.test/v1', wire_api: 'responses' },
        },
      } }
      if (method === 'thread/resume') return { modelProvider: 'custom_endpoint', thread: { turns: [] } }
      if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const processor = createProcessor(rpc)

    await processor.processThreadQueue('old-provider-thread')

    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'old-provider-thread', modelProvider: 'custom_endpoint', model: 'cx/config-only-advertised', excludeTurns: true,
    })
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: 'cx/config-only-advertised' }))
    expect(rpc.mock.calls.filter(([method]) => method === 'config/read')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://config-only.example.test/v1/models')
    expect(await readSavedQueue(home)).toBeUndefined()
  })

  it('falls back to the current provider model list when no model is configured', async () => {
    const home = await createQueueHome()
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: { model_provider: 'openai', model: null } }
      if (method === 'model/list') return { data: [{ id: 'native-listed-model' }] }
      if (method === 'thread/resume') return { modelProvider: 'openai', thread: { turns: [] } }
      if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const processor = createProcessor(rpc)

    await processor.processThreadQueue('old-provider-thread')

    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'old-provider-thread', modelProvider: 'openai', model: 'native-listed-model', excludeTurns: true,
    })
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: 'native-listed-model' }))
    expect(await readSavedQueue(home)).toBeUndefined()
  })

  it('chooses an advertised custom model instead of an unvalidated configured model', async () => {
    const home = await createQueueHome()
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({
      enabled: true, provider: 'custom', customBaseUrl: 'https://fixture.example.test/v1',
      apiKey: '', model: 'Ggh', wireApi: 'responses',
    }), 'utf8')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'cx/supported-literal' }, { id: 'cx/second' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: { model_provider: 'custom_endpoint', model: 'Ggh' } }
      if (method === 'thread/resume') return { modelProvider: 'custom_endpoint', thread: { turns: [] } }
      if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const processor = createProcessor(rpc)

    await processor.processThreadQueue('old-provider-thread')

    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'old-provider-thread', modelProvider: 'custom_endpoint',
      model: 'cx/supported-literal', excludeTurns: true,
    })
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      model: 'cx/supported-literal',
      collaborationMode: expect.objectContaining({ settings: expect.objectContaining({ model: 'cx/supported-literal' }) }),
    }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://fixture.example.test/v1/models')
    expect(rpc.mock.calls.filter(([method]) => method === 'config/read')).toHaveLength(1)
    expect(await readSavedQueue(home)).toBeUndefined()
    const saved = JSON.parse(await readFile(join(home, FREE_MODE_STATE_FILE), 'utf8'))
    expect(saved.model).toBe('Ggh')
  })

  it.each(['openai', undefined])('blocks a hot queued resume returning provider %s without losing its message', async (returnedProvider) => {
    const home = await createQueueHome()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: { model_provider: 'custom_endpoint', model: 'cx/current' } }
      if (method === 'thread/resume') return {
        modelProvider: returnedProvider, thread: { modelProvider: 'custom_endpoint', turns: [] },
      }
      if (method === 'turn/start') return { turn: { id: 'must-not-start' } }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const processor = createProcessor(rpc)

    await processor.processThreadQueue('old-provider-thread')

    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
    expect(await readSavedQueue(home)).toEqual({ 'old-provider-thread': [queuedMessage] })
    expect(warning).toHaveBeenCalledWith('[codex] queued turn provider mismatch:', expect.stringMatching(
      /provider.*custom_endpoint.*loaded.*active writer/i,
    ))
  })

  it('resumes an existing queued thread with the exact current config provider before starting', async () => {
    const home = await createQueueHome()
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } }
      if (method === 'config/read') return { config: {
        model_provider: 'Exact_Provider_ID', model: 'cx/literal-provider-model', model_reasoning_effort: 'high',
      } }
      if (method === 'thread/resume') return {
        modelProvider: 'Exact_Provider_ID', model: 'cx/literal-provider-model',
        thread: { modelProvider: 'openai', turns: [] },
      }
      if (method === 'turn/start') return { turn: { id: 'fixture-turn' } }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const processor = createProcessor(rpc)

    await processor.processThreadQueue('old-provider-thread')

    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'thread/read', 'config/read', 'thread/resume', 'turn/start',
    ])
    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'old-provider-thread', modelProvider: 'Exact_Provider_ID',
      model: 'cx/literal-provider-model', excludeTurns: true,
    })
    expect(rpc).toHaveBeenCalledWith('turn/start', {
      threadId: 'old-provider-thread', model: 'cx/literal-provider-model',
      input: [{ type: 'text', text: 'queued fixture prompt' }],
      collaborationMode: { mode: 'default', settings: {
        model: 'cx/literal-provider-model', reasoning_effort: 'high', developer_instructions: null,
      } },
    })
    expect(await readSavedQueue(home)).toBeUndefined()
  })
})

describe('global provider routing during turn/start thread recovery', () => {
  it('uses the global Zen model when a recovered request still names an old native model', async () => {
    await createQueueHome()
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    let starts = 0
    const rpc = vi.fn(async (method: string) => {
      if (method === 'turn/start') {
        if (++starts === 1) throw new Error('thread not found: recovered-thread')
        return { turn: { id: 'fixture-recovered-turn' } }
      }
      if (method === 'config/read') return { config: { model_provider: 'opencode_zen', model: 'zen-current-global' } }
      if (method === 'thread/resume') return { modelProvider: 'opencode_zen', thread: { turns: [] } }
      throw new Error(`unexpected RPC: ${method}`)
    })

    await callRpcWithArchiveRecovery({ rpc }, 'turn/start', {
      threadId: 'recovered-thread', model: 'old-native-model', input: [],
    })

    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'recovered-thread', modelProvider: 'opencode_zen', model: 'zen-current-global', excludeTurns: true,
    })
  })

  it('does not carry a stale native model into recovery for the globally selected OpenRouter provider', async () => {
    const home = await createQueueHome()
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({
      enabled: true, provider: 'openrouter', apiKey: '', model: 'vendor/current-global', customKey: true,
    }), 'utf8')
    let starts = 0
    const rpc = vi.fn(async (method: string) => {
      if (method === 'turn/start') {
        if (++starts === 1) throw new Error('thread not found: recovered-thread')
        return { turn: { id: 'fixture-recovered-turn' } }
      }
      if (method === 'config/read') return { config: { model_provider: 'openrouter_free', model: 'vendor/current-global' } }
      if (method === 'thread/resume') return { modelProvider: 'openrouter_free', thread: { turns: [] } }
      throw new Error(`unexpected RPC: ${method}`)
    })

    await callRpcWithArchiveRecovery({ rpc }, 'turn/start', {
      threadId: 'recovered-thread', model: 'old-native-model', input: [],
    })

    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'recovered-thread', modelProvider: 'openrouter_free', model: 'vendor/current-global', excludeTurns: true,
    })
    expect(rpc.mock.calls[3]).toEqual(['turn/start', {
      threadId: 'recovered-thread', model: 'vendor/current-global', input: [],
    }])
  })

  it.each(['openai', undefined])('rejects recovered provider %s before retrying turn/start', async (returnedProvider) => {
    await createQueueHome()
    const rpc = vi.fn(async (method: string) => {
      if (method === 'turn/start') throw new Error('thread not found: recovered-thread')
      if (method === 'config/read') return { config: { model_provider: 'custom_endpoint', model: 'cx/current' } }
      if (method === 'thread/resume') return {
        modelProvider: returnedProvider, thread: { modelProvider: 'custom_endpoint', turns: [] },
      }
      throw new Error(`unexpected RPC: ${method}`)
    })

    await expect(callRpcWithArchiveRecovery({ rpc }, 'turn/start', {
      threadId: 'recovered-thread', model: 'cx/current', input: [],
    })).rejects.toThrow(/configured provider "custom_endpoint".*returned.*loaded.*active writer/i)
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })

  it('changes only retry models when a requested old-provider model is absent from custom discovery', async () => {
    const home = await createQueueHome()
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({
      enabled: true, provider: 'custom', customBaseUrl: 'https://fixture.example.test/v1',
      apiKey: '', model: 'Ggh', wireApi: 'responses',
    }), 'utf8')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'cx/advertised' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    let starts = 0
    const rpc = vi.fn(async (method: string) => {
      if (method === 'turn/start') {
        if (++starts === 1) throw new Error('thread not found: recovered-thread')
        return { turn: { id: 'fixture-recovered-turn' } }
      }
      if (method === 'config/read') return { config: { model_provider: 'custom_endpoint', model: 'Ggh' } }
      if (method === 'thread/resume') return { modelProvider: 'custom_endpoint', thread: { turns: [] } }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const params = {
      threadId: 'recovered-thread', model: 'old-native-model', input: [{ type: 'text', text: 'keep prompt' }],
      collaborationMode: { mode: 'plan', settings: {
        model: 'old-native-model', reasoning_effort: 'high', developer_instructions: 'keep instructions',
      } },
    }

    await callRpcWithArchiveRecovery({ rpc }, 'turn/start', params)

    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'recovered-thread', modelProvider: 'custom_endpoint', model: 'cx/advertised', excludeTurns: true,
    })
    expect(rpc.mock.calls[3]).toEqual(['turn/start', {
      ...params, model: 'cx/advertised',
      collaborationMode: { ...params.collaborationMode, settings: {
        ...params.collaborationMode.settings, model: 'cx/advertised',
      } },
    }])
    expect(params.model).toBe('old-native-model')
    expect(params.collaborationMode.settings.model).toBe('old-native-model')
  })

  it('recovers the missing thread with the current provider and the requested provider-compatible model', async () => {
    const home = await createQueueHome()
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({
      enabled: true, provider: 'custom', customBaseUrl: 'https://fixture.example.test/v1',
      apiKey: '', model: 'Ggh', wireApi: 'responses',
    }), 'utf8')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'cx/first' }, { id: 'cx/requested-literal' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    let starts = 0
    const rpc = vi.fn(async (method: string) => {
      if (method === 'turn/start') {
        if (++starts === 1) throw new Error('thread not found: recovered-thread')
        return { turn: { id: 'fixture-recovered-turn' } }
      }
      if (method === 'config/read') return { config: { model_provider: 'custom_endpoint', model: 'Ggh' } }
      if (method === 'thread/resume') return { modelProvider: 'custom_endpoint', thread: { modelProvider: 'openai', turns: [] } }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const params = {
      threadId: 'recovered-thread', model: 'cx/requested-literal',
      input: [{ type: 'text', text: 'recovery fixture' }],
      collaborationMode: { mode: 'plan', settings: {
        model: 'cx/requested-literal', reasoning_effort: 'high', developer_instructions: 'preserve this',
      } },
    }

    await expect(callRpcWithArchiveRecovery({ rpc }, 'turn/start', params)).resolves.toEqual({
      turn: { id: 'fixture-recovered-turn' },
    })

    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['turn/start', 'config/read', 'thread/resume', 'turn/start'])
    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'recovered-thread', modelProvider: 'custom_endpoint', model: 'cx/requested-literal', excludeTurns: true,
    })
    expect(rpc.mock.calls[3]).toEqual(['turn/start', params])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(join(home, FREE_MODE_STATE_FILE), 'utf8')).model).toBe('Ggh')
  })
})

class FixtureResponse extends Writable {
  statusCode = 200
  body = ''
  setHeader(): this { return this }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.body += chunk.toString('utf8')
    callback()
  }
}

describe('provider settings app-server disposal', () => {
  it.each(['custom', 'opencode-zen', 'openrouter', 'ninerouter'])(
    'disposes loaded threads even when saving the same %s provider', async (provider) => {
      const home = await createQueueHome()
      await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({
        enabled: true, provider, customBaseUrl: 'https://old.example.test/v1',
        apiKey: '', model: 'cx/previous', customKey: true,
      }), 'utf8')
      await writeFile(join(home, 'telegram-bridge.json'), '{}', 'utf8')
      const dispose = vi.fn()
      const rpc = vi.fn(async () => { throw new Error('saving an existing provider must not spawn or call Codex') })
      vi.stubGlobal('__codexRemoteSharedBridge__', {
        version: 'experimental-api-v2', appServer: { rpc, dispose }, terminalManager: {},
        methodCatalog: {}, telegramBridge: {}, backendQueueProcessor: {},
      })
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        data: [{ id: 'cx/saved-advertised' }],
      }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const request = Readable.from([JSON.stringify({ provider, baseUrl: 'https://new.example.test/v1', apiKey: '', wireApi: 'responses' })])
      Object.assign(request, { method: 'POST', url: '/codex-api/free-mode/custom-provider', headers: {} })
      const response = new FixtureResponse()
      const next = vi.fn()

      await createCodexBridgeMiddleware()(request as IncomingMessage, response as unknown as ServerResponse, next)

      expect(next).not.toHaveBeenCalled()
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ ok: true })
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(rpc).not.toHaveBeenCalled()
      const saved = JSON.parse(await readFile(join(home, FREE_MODE_STATE_FILE), 'utf8'))
      expect(saved.provider).toBe(provider)
      if (provider === 'custom') {
        expect(saved.customBaseUrl).toBe('https://new.example.test/v1')
        expect(saved.model).toBe('cx/saved-advertised')
        expect(fetchMock).toHaveBeenCalledTimes(1)
      } else {
        expect(fetchMock).not.toHaveBeenCalled()
      }
    },
  )
})
