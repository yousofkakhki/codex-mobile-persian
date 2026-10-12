import { describe, expect, it, vi } from 'vitest'
import { proxyNineRouterDictation, usesNineRouterDictation } from './dictationTranscription'

describe('NineRouter dictation transcription', () => {
  it('uses NineRouter only when it is the active provider', () => {
    expect(usesNineRouterDictation({ enabled: true, provider: 'ninerouter', apiKey: null, model: '' }, null)).toBe(true)
    expect(usesNineRouterDictation({ enabled: false, provider: 'ninerouter', apiKey: null, model: '' }, null)).toBe(true)
    expect(usesNineRouterDictation({ enabled: true, provider: 'opencode-zen', apiKey: null, model: '' }, 'ninerouter')).toBe(false)
    expect(usesNineRouterDictation({ enabled: false, provider: 'codex', apiKey: null, model: '' }, 'ninerouter')).toBe(false)
    expect(usesNineRouterDictation(null, 'ninerouter')).toBe(true)
    expect(usesNineRouterDictation(null, null)).toBe(false)
  })

  it('forwards multipart audio and the server credential only to the local NineRouter endpoint', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ text: 'recognized words' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const body = Buffer.from('synthetic audio fixture')
    const contentType = 'multipart/form-data; boundary=fixture-boundary'

    await expect(proxyNineRouterDictation(body, contentType, 'fixture-router-key', request)).resolves.toEqual({
      status: 200,
      body: JSON.stringify({ text: 'recognized words' }),
    })
    expect(request).toHaveBeenCalledTimes(1)
    const [url, options] = request.mock.calls[0] ?? []
    expect(url).toBe('http://127.0.0.1:20128/v1/audio/transcriptions')
    expect(options?.method).toBe('POST')
    expect(options?.headers).toEqual({
      Authorization: 'Bearer fixture-router-key',
      'Content-Type': contentType,
    })
    expect(Array.from(options?.body as Uint8Array)).toEqual(Array.from(body))
    expect(options?.redirect).toBe('error')
  })

  it('does not send requests without a configured server credential', async () => {
    const request = vi.fn<typeof fetch>()
    await expect(proxyNineRouterDictation(Buffer.alloc(0), 'application/octet-stream', ' ', request))
      .rejects.toThrow('NineRouter API key is unavailable')
    expect(request).not.toHaveBeenCalled()
  })
})
