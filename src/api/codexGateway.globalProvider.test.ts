import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAvailableModelIds, getThreadDetail, resumeThread } from './codexGateway'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
function rpc(result: unknown) { return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
function resumed(modelProvider = 'custom_endpoint', model = 'cx/gpt-6.1-sol') {
  return { thread: { id: 'fixture', turns: [], status: 'idle' }, model, modelProvider, initialTurnsPage: { data: [], nextCursor: 'older-page' } }
}
describe('provider catalog failure contract', () => {
  it('uses the same explicit global override contract through direct detail loads', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return rpc(resumed())
    }))
    await getThreadDetail('detail-global-custom', { modelProvider: 'custom', model: 'cx/gpt-6.1-sol' })
    expect(requests[0].params).toMatchObject({ modelProvider: 'custom_endpoint', model: 'cx/gpt-6.1-sol', excludeTurns: true, initialTurnsPage: { limit: 10 } })
  })
  it('does not silently retry an explicitly selected custom provider through OpenAI when registration is missing', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)).method)
      return new Response(JSON.stringify({ error: 'Model provider `custom_endpoint` not found' }), { status: 502 })
    }))
    await expect(resumeThread('explicit-custom-missing', { modelProvider: 'custom_endpoint', model: 'cx/gpt-6.1-sol' })).rejects.toThrow(/not found/)
    expect(calls).toHaveLength(1)
  })
  it('coalesces equal overrides but never reuses the old provider resume after a switch', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      requests.push(request)
      return rpc(resumed(request.params.modelProvider, request.params.model))
    }))
    await Promise.all([resumeThread('switched-cache', { modelProvider: 'openai', model: 'old-model' }), resumeThread('switched-cache', { modelProvider: 'codex', model: 'old-model' })])
    const next = await resumeThread('switched-cache', { modelProvider: 'custom_endpoint', model: 'cx/gpt-6.1-sol' })
    expect(requests).toHaveLength(2)
    expect(next.modelProvider).toBe('custom_endpoint')
    expect(next.model).toBe('cx/gpt-6.1-sol')
  })
  it('resumes an existing thread with global custom provider and literal compatible model overrides', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return rpc(resumed())
    }))
    await resumeThread('global-custom-thread', { modelProvider: 'custom', model: 'cx/gpt-6.1-sol' })
    expect(requests).toEqual([{ method: 'thread/resume', params: {
      threadId: 'global-custom-thread', modelProvider: 'custom_endpoint', model: 'cx/gpt-6.1-sol',
      excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' },
    } }])
  })
  it('canonicalizes custom aliases when querying the provider catalog', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ data: ['cx/gpt-6.1-sol'], exclusive: true }), { status: 200 })
    }))
    await getAvailableModelIds({ requireProviderModels: true, providerId: ' CUSTOM ' })
    expect(urls).toEqual(['/codex-api/provider-models?provider=custom_endpoint'])
  })
  it('rejects a required catalog HTTP error without falling back to ChatGPT model/list', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'fixture catalog unavailable' }), { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(getAvailableModelIds({ requireProviderModels: true, providerId: 'custom_endpoint' })).rejects.toThrow(/catalog/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
