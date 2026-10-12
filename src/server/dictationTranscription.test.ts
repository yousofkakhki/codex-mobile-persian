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
    const incoming = new FormData()
    incoming.append('file', new File([new Uint8Array([1, 2, 3])], 'codex.webm', { type: 'audio/webm' }))
    incoming.append('language', 'fa')
    incoming.append('model', 'untrusted/model')
    const encodedRequest = new Request('http://localhost/codex-api/transcribe', { method: 'POST', body: incoming })
    const body = Buffer.from(await encodedRequest.arrayBuffer())
    const contentType = encodedRequest.headers.get('content-type')!

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
    const forwardedBody = options?.body as Uint8Array
    const forwardedRequest = new Request('http://localhost/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: Uint8Array.from(forwardedBody).buffer as ArrayBuffer,
    })
    const forwarded = await forwardedRequest.formData()
    expect(forwarded.get('model')).toBe('codex/codex-dictation')
    expect(forwarded.getAll('model')).toEqual(['codex/codex-dictation', 'untrusted/model'])
    expect(forwarded.get('language')).toBe('fa')
    expect((forwarded.get('file') as File).name).toBe('codex.webm')
    expect(options?.redirect).toBe('error')
  })

  it('rejects malformed multipart without contacting NineRouter', async () => {
    const request = vi.fn<typeof fetch>()
    const malformed = await proxyNineRouterDictation(Buffer.from('bad'), 'multipart/form-data; boundary=missing', 'fixture-key', request)
    expect(malformed.status).toBe(400)
    expect(request).not.toHaveBeenCalled()
  })

  it('supports NineRouter instances that do not require an API key', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }))
    const incoming = new FormData()
    incoming.append('file', new File([new Uint8Array([1])], 'codex.webm', { type: 'audio/webm' }))
    const encodedRequest = new Request('http://localhost/codex-api/transcribe', { method: 'POST', body: incoming })

    await expect(proxyNineRouterDictation(
      Buffer.from(await encodedRequest.arrayBuffer()),
      encodedRequest.headers.get('content-type')!,
      ' ',
      request,
    )).resolves.toMatchObject({ status: 200 })
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Content-Type': encodedRequest.headers.get('content-type') })
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
  })
})
