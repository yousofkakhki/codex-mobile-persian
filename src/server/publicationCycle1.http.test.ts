import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type RequestListener } from 'node:http'
import { EventEmitter } from 'node:events'
import { handleCustomEndpointModelsRequest } from './customEndpointProxy'

const servers: Server[] = []
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind loopback')
  return `http://127.0.0.1:${address.port}`
}
async function proxy(baseUrl: string): Promise<string> {
  return listen((req, res) => handleCustomEndpointModelsRequest(req, res, {
    baseUrl, bearerToken: 'NON_SECRET_BEARER_FIXTURE',
  }))
}
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

async function invokeSyntheticProxy(): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise(resolve => {
    let status = 0
    let headers: Record<string, string> = {}
    const response = Object.assign(new EventEmitter(), {
      headersSent: false, writableEnded: false,
      writeHead: (code: number, values: Record<string, string>) => { status = code; headers = values },
      end: (body: string | Buffer) => resolve({ status, headers, body: String(body) }),
    })
    handleCustomEndpointModelsRequest({ url: '/models' } as never, response as never, {
      baseUrl: 'http://127.0.0.1:59000/v1', bearerToken: 'NON_SECRET_BEARER_FIXTURE',
    })
  })
}

describe('publication cycle 1 models JSON boundary', () => {
  it('PUB-HTTP-03 never relays a provider failure body even with a valid catalog shape', async () => {
    let cancelled = false
    let bodyRead = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyRead = true
        controller.enqueue(Buffer.from('{"data":[],"error":{"message":"NON_SECRET_PROVIDER_CREDENTIAL"}}'))
        controller.close()
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }), { status: 401, headers: { 'Content-Type': 'application/json' } })))
    const response = await invokeSyntheticProxy()
    expect(response.status).toBe(502)
    expect(response.body).not.toContain('NON_SECRET_PROVIDER_CREDENTIAL')
    expect(bodyRead).toBe(false)
    expect(cancelled).toBe(true)
  })
  it.each([new Error('https://fixture.invalid/v1/models?key=NON_SECRET_ERROR_CREDENTIAL'), new TypeError('NON_SECRET_ERROR_CREDENTIAL'), 'NON_SECRET_ERROR_CREDENTIAL'])('PUB-HTTP-03 never echoes transport exception %s', async error => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw error }))
    const response = await invokeSyntheticProxy()
    expect(response.status).toBe(502)
    expect(JSON.parse(response.body)).toEqual({ error: { message: 'Custom endpoint models request failed' } })
    expect(response.headers['Content-Type']).toBe('application/json')
    expect(response.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(response.body).not.toContain('NON_SECRET_ERROR_CREDENTIAL')
    expect(response.body).not.toContain('fixture.invalid')
  })
  it('PUB-HTTP-02 cancels a rejected media body without awaiting hostile cancellation', async () => {
    let cancelled = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; return new Promise<void>(() => {}) },
    }), { headers: { 'Content-Type': 'text/html' } })))
    const response = await invokeSyntheticProxy()
    expect(response.status).toBe(502)
    expect(cancelled).toBe(true)
  })
  it('PUB-HTTP-02 returns by the bounded deadline even if stalled body cancellation never settles', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => controller.signal)
    let cancelled = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}) },
      cancel() { cancelled = true; return new Promise<void>(() => {}) },
    }), { headers: { 'Content-Type': 'application/json' } })))
    const abortTimer = setTimeout(() => controller.abort(), 25)
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        invokeSyntheticProxy(),
        new Promise<{ status: number }>(resolve => { guard = setTimeout(() => resolve({ status: 0 }), 250) }),
      ])
      expect(response.status).toBe(502)
      expect(timeout).toHaveBeenCalledWith(8000)
      expect(cancelled).toBe(true)
    } finally {
      clearTimeout(abortTimer)
      clearTimeout(guard)
    }
  })
  it.each([undefined, '1'])('PUB-HTTP-02 caps consumed stream bytes with Content-Length %s', async contentLength => {
    let produced = 0
    let cancelled = false
    const full = Buffer.from(JSON.stringify({ data: [{ id: 'large-model', padding: 'x'.repeat(2 * 1024 * 1024) }] }))
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const start = produced++ * 65536
        if (start < full.length) controller.enqueue(full.subarray(start, start + 65536))
        else controller.close()
      },
      cancel() { cancelled = true },
    })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (contentLength !== undefined) headers['Content-Length'] = contentLength
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers })))
    const response = await invokeSyntheticProxy()
    expect(response.status).toBe(502)
    expect(response.body).not.toContain('large-model')
    expect(cancelled).toBe(true)
    expect(produced).toBeLessThanOrEqual(18) // limit crossing + at most one stream-prefetch chunk
  })
  it('PUB-HTTP-02 never follows an unapproved redirect from the configured local gateway', async () => {
    let targetCalls = 0
    const target = await listen((_req, res) => {
      targetCalls++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"data":[{"id":"REDIRECT_TARGET_MODEL"}]}')
    })
    const upstream = await listen((_req, res) => {
      res.writeHead(302, { Location: `${target}/unconfigured-target` })
      res.end()
    })
    const response = await fetch(`${await proxy(upstream)}/models`)
    expect(targetCalls).toBe(0)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('REDIRECT_TARGET_MODEL')
  })
  it('PUB-HTTP-01 returns canonical JSON media type and nosniff for valid configured local gateway JSON', async () => {
    let url = ''
    let authorization = ''
    const catalog = { object: 'list', data: [{ id: 'cx/gpt-6.1-sol', context_length: 872000, capabilities: { reasoning: true } }] }
    const upstream = await listen((req, res) => {
      url = req.url ?? ''
      authorization = String(req.headers.authorization)
      res.writeHead(200, { 'Content-Type': 'Application/JSON; charset=utf-8' })
      res.end(JSON.stringify(catalog))
    })
    const response = await fetch(`${await proxy(`${upstream}/v1`)}/models?client_version=0.154.0`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(catalog)
    expect(url).toBe('/v1/models?client_version=0.154.0')
    expect(authorization).toBe('Bearer NON_SECRET_BEARER_FIXTURE')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
  it.each(['<script>ACTIVE_JSON_FIXTURE</script>', 'null', '[]', '{"data":[{"id":17}]}', '{"error":{"message":"ACTIVE_JSON_FIXTURE"}}'])('PUB-HTTP-01 rejects invalid models JSON %s', async raw => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(raw)
    })
    const response = await fetch(`${await proxy(upstream)}/models`)
    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.json()).toEqual({ error: { message: 'Custom endpoint models request failed' } })
  })
  it('PUB-HTTP-01 rejects active upstream HTML at the application origin', async () => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><script>window.UNTRUSTED_ACTIVE_HTML=true</script>')
    })
    const response = await fetch(`${await proxy(upstream)}/models`)
    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).not.toContain('UNTRUSTED_ACTIVE_HTML')
    expect(JSON.parse(body)).toEqual({ error: { message: 'Custom endpoint models request failed' } })
  })
})
