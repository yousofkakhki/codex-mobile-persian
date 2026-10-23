import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Never borrow the runner's Codex home: it may belong to a running installation.
const inheritedHome = process.env.CODEX_HOME
let home = ''
const serverMarker = 'fixture-server-marker'
const clientMarker = 'fixture-client-marker'
let bridge: Awaited<ReturnType<typeof import('./codexAppServerBridge')['createCodexBridgeMiddleware']>>
let upstream: Server
let app: Server
let target: Server
let origin: string
let redirectedHits = 0
let seen: Array<{ url: string; authorization: string | undefined; form: FormData }> = []
let reply: (req: IncomingMessage, res: ServerResponse) => void
const nativeFetch = globalThis.fetch
const timeout = AbortSignal.timeout.bind(AbortSignal)
async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
async function formRequest(form?: FormData) {
  const input = form ?? new FormData()
  if (!form) {
    input.append('file', new File([new Uint8Array([0, 1, 255, 13, 10])], 'codex.webm', { type: 'audio/webm' }))
    input.append('language', 'fa')
    input.append('model', 'caller-model-first')
    input.append('model', 'caller-model-last')
  }
  return new Request(origin + '/codex-api/transcribe', { method: 'POST', body: input })
}
async function send(form?: FormData) {
  const input = await formRequest(form)
  return nativeFetch(input.url, { method: 'POST', headers: {
    'Content-Type': input.headers.get('content-type')!, Authorization: `Bearer ${clientMarker}`,
  }, body: await input.arrayBuffer() })
}
async function assertSafe(response: Response, status = 502) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cache-control')).toBe('no-store')
  const text = await response.text()
  expect(text).not.toContain(serverMarker)
  expect(text).not.toContain(clientMarker)
  expect(text).not.toContain('<script>')
  expect(JSON.parse(text)).toEqual({ error: expect.any(String) })
}
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'codexui-dictation-http-'))
  vi.stubEnv('CODEX_HOME', home)
  await writeFile(join(home, 'webui-custom-providers.json'), JSON.stringify({ enabled: true, provider: 'ninerouter', apiKey: null, model: '' }))
  vi.stubEnv('NINEROUTER_API_KEY', serverMarker)
  // No process spawning, queue polling, activity writing or Telegram configuration.
  vi.stubGlobal('__codexRemoteSharedBridge__', { version: 'experimental-api-v2', appServer: {},
    terminalManager: {}, methodCatalog: {}, telegramBridge: {}, backendQueueProcessor: {},
    activityStore: {}, activityRecorder: { recordQueue() {} } })
  const { createCodexBridgeMiddleware } = await import('./codexAppServerBridge')
  bridge = createCodexBridgeMiddleware()
  target = createServer((_req, res) => { redirectedHits++; res.end('{}') })
  const targetUrl = await listen(target)
  upstream = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const encoded = new Request('http://fixture/v1/audio/transcriptions', { method: 'POST',
      headers: { 'Content-Type': req.headers['content-type']! }, body: Uint8Array.from(Buffer.concat(chunks)).buffer })
    seen.push({ url: req.url!, authorization: req.headers.authorization, form: await encoded.formData() })
    if (req.headers['x-fixture-redirect']) res.setHeader('Location', targetUrl)
    reply(req, res)
  })().catch(() => { res.statusCode = 500; res.end('{}') }) })
  vi.stubEnv('NINEROUTER_BASE_URL', `${await listen(upstream)}/v1`)
  origin = await listen(app = createServer((req, res) => { void bridge(req, res, () => { res.statusCode = 404; res.end() }) }))
  ;(globalThis as typeof globalThis & { fixtureRedirectUrl?: string }).fixtureRedirectUrl = targetUrl
})
beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', nativeFetch)
  seen = []
  redirectedHits = 0
  process.env.NINEROUTER_API_KEY = serverMarker
  reply = (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: 'recognized words' })) }
})
afterAll(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try {
    await Promise.all([app, upstream, target].filter(Boolean).map(close))
  } finally {
    vi.unstubAllEnvs()
    if (home) await rm(home, { recursive: true, force: true })
  }
})
describe('NineRouter real HTTP dictation boundary', () => {
  it('owns a disposable Codex home instead of writing inherited application state', () => {
    expect(home).not.toBe(inheritedHome)
    expect(home).toMatch(/codexui-dictation-http-/u)
    expect(process.env.CODEX_HOME).toBe(home)
    expect(new URL(process.env.NINEROUTER_BASE_URL!).port).not.toBe('20128')
  })
  it('reports unsupported STT as fixed unavailable JSON without forwarding the provider error', async () => {
    reply = (_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: serverMarker })) }
    const response = await send()
    await assertSafe(response.clone(), 503)
    expect(await response.json()).toEqual({ error: 'NineRouter dictation is unavailable' })
  })
  it.each(['text', 'transcription'])('returns only recognized %s envelope, never extra provider data', async field => {
    reply = (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ [field]: 'recognized words', metadata: serverMarker })) }
    expect(await (await send()).json()).toEqual({ [field]: 'recognized words' })
  })

  it.each(['oversize-length', 'oversize-chunked', 'false-length', 'wrong-media-json', 'stalled-body', 'stalled-headers', 'stalled-fetch', 'cancel-never'])('bounds %s under safe HTTP JSON', async mode => {
    // Shorten only stalled controls; oversize streams retain the production deadline.
    if (mode.startsWith('stalled')) vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 300_000 ? 80 : ms))
    if (mode === 'stalled-fetch') vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    else if (mode === 'false-length') vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close() },
    }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }))
    else if (mode === 'cancel-never') vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(1024 * 1024 + 1))) },
      cancel() { return new Promise(() => {}) },
    }), { headers: { 'Content-Type': 'application/json' } }))
    else reply = (_req, res) => {
      res.setHeader('Content-Type', mode === 'wrong-media-json' ? 'text/html' : 'application/json')
      if (mode === 'oversize-length') { res.setHeader('Content-Length', 1024 * 1024 + 1); res.flushHeaders() }
      else if (mode === 'oversize-chunked') { res.flushHeaders(); res.end(JSON.stringify({ text: 'x'.repeat(1024 * 1024) })) }
      else if (mode === 'stalled-body') { res.flushHeaders(); res.write('{"text":"') }
      else if (mode === 'stalled-headers') { /* deliberately no headers */ }
      else res.end('{"text":"should not be accepted"}')
    }
    const result = await Promise.race([send(), new Promise<'late'>(resolve => setTimeout(() => resolve('late'), 500))])
    expect(result).not.toBe('late')
    await assertSafe(result as Response, mode.startsWith('stalled') ? 504 : 502)
  })
  it.each(['declared', 'chunked'])('bounds incoming %s body before forwarding', async mode => {
    const input = await formRequest()
    const response = await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(origin + '/codex-api/transcribe', { method: 'POST', headers: {
        'Content-Type': input.headers.get('content-type')!,
        ...(mode === 'declared' ? { 'Content-Length': 25 * 1024 * 1024 + 1 } : {}),
      } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode,
          headers: res.headers as Record<string, string> })))
      })
      req.on('error', reject)
      if (mode === 'declared') req.end('x')
      else req.end(Buffer.alloc(25 * 1024 * 1024 + 1, 120))
    })
    await assertSafe(response, 413)
    expect(seen).toHaveLength(0)
  })
  it('bounds stalled incoming request reads', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 300_000 ? 80 : ms))
    const response = await new Promise<Response | 'late'>((resolve, reject) => {
      const req = httpRequest(origin + '/codex-api/transcribe', { method: 'POST', headers: {
        'Content-Type': 'multipart/form-data; boundary=fixture', 'Transfer-Encoding': 'chunked',
      } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })))
      })
      req.on('error', reject)
      req.write('--fixture\r\n')
      setTimeout(() => { resolve('late'); req.destroy() }, 500)
    })
    expect(response).not.toBe('late')
    await assertSafe(response as Response, 408)
    expect(seen).toHaveLength(0)
  })

  it.each(['missing-file', 'duplicate-file', 'duplicate-language', 'invalid-language', 'text-file', 'unknown-field'])('rejects %s before contacting gateway', async mode => {
    const form = new FormData()
    if (mode === 'text-file') form.append('file', 'not-a-file')
    else if (mode !== 'missing-file') form.append('file', new File([new Uint8Array([1])], 'codex.webm', { type: 'audio/webm' }))
    if (mode === 'duplicate-file') form.append('file', new File([new Uint8Array([2])], 'other.webm'))
    if (mode === 'duplicate-language') { form.append('language', 'en'); form.append('language', 'fa') }
    if (mode === 'invalid-language') form.append('language', 'fa\r\nInjected: bad')
    if (mode === 'unknown-field') form.append('Authorization', clientMarker)
    await assertSafe(await send(form), 400)
    expect(seen).toHaveLength(0)
  })
  it('rejects incomplete multipart framing without contacting gateway', async () => {
    const response = await nativeFetch(origin + '/codex-api/transcribe', { method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=fixture' },
      body: '--fixture\r\nContent-Disposition: form-data; name="file"; filename="codex.webm"\r\n\r\naudio' })
    await assertSafe(response, 400)
    expect(seen).toHaveLength(0)
  })

  it('preserves audio bytes/language, uses exactly one fixed model and only server credentials', async () => {
    const response = await send()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'recognized words' })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('/v1/audio/transcriptions')
    expect(seen[0].authorization).toBe(`Bearer ${serverMarker}`)
    expect(seen[0].form.getAll('model')).toEqual(['cx/codex-dictation'])
    expect(seen[0].form.get('language')).toBe('fa')
    const file = seen[0].form.get('file') as File
    expect(file.name).toBe('codex.webm')
    expect(file.type).toBe('audio/webm')
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 1, 255, 13, 10])
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  it('supports keyless instances without forwarding browser authorization', async () => {
    delete process.env.NINEROUTER_API_KEY
    expect((await send()).status).toBe(200)
    expect(seen[0].authorization).toBeUndefined()
  })
  it.each(['provider500', 'html', 'invalid-json', 'malformed-envelope', 'throw'])('owns safe JSON for %s', async mode => {
    if (mode === 'throw') vi.stubGlobal('fetch', vi.fn(() => { throw new Error(serverMarker + clientMarker) }))
    else reply = (_req, res) => {
      res.setHeader('Content-Type', mode === 'html' ? 'text/html' : 'application/json')
      if (mode === 'provider500') res.statusCode = 500
      res.end(mode === 'provider500' ? JSON.stringify({ error: serverMarker })
        : mode === 'html' ? '<script>' + serverMarker + '</script>'
        : mode === 'invalid-json' ? serverMarker : JSON.stringify({ error: serverMarker }))
    }
    await assertSafe(await send())
  })
  it('does not forward credentials to a redirect target', async () => {
    reply = (_req, res) => { res.writeHead(307, { Location: (globalThis as typeof globalThis & { fixtureRedirectUrl?: string }).fixtureRedirectUrl! }); res.end(serverMarker) }
    await assertSafe(await send())
    expect(redirectedHits).toBe(0)
  })
})
