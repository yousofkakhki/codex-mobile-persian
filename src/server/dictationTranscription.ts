import type { IncomingMessage, ServerResponse } from 'node:http'
import { getNinerouterBaseUrl, NINEROUTER_PROVIDER_ID, type FreeModeState } from './freeMode.js'

export function usesNineRouterDictation(state: FreeModeState | null, configuredProvider: string | null): boolean {
  if (state?.provider === 'codex') return false
  if (state?.enabled) return state.provider === NINEROUTER_PROVIDER_ID
  return state?.provider === NINEROUTER_PROVIDER_ID || configuredProvider === NINEROUTER_PROVIDER_ID
}

export const DICTATION_MAX_REQUEST_BYTES = 25 * 1024 * 1024
export const DICTATION_MAX_RESPONSE_BYTES = 1024 * 1024
const DICTATION_DEADLINE_MS = 300_000
class DictationInputError extends Error {
  constructor(readonly status: number) { super('Invalid dictation request') }
}
async function awaitDictationOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Dictation deadline exceeded'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([operation, aborted]) } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
function cancelDictationBody(body: ReadableStream<Uint8Array> | null): void {
  try { void body?.cancel().catch(() => {}) } catch { /* cleanup must never defeat the deadline */ }
}
async function readDictationResponse(response: Response, signal: AbortSignal): Promise<string> {
  const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const length = response.headers.get('content-length')
  if (!response.ok || media !== 'application/json' || (length !== null && (!/^\d+$/u.test(length) || Number(length) > DICTATION_MAX_RESPONSE_BYTES))) {
    cancelDictationBody(response.body)
    throw new Error('Invalid upstream response')
  }
  if (!response.body) throw new Error('Missing upstream response')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await awaitDictationOperation(reader.read(), signal)
      if (done) { complete = true; return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)) }
      bytes += value.byteLength
      if (bytes > DICTATION_MAX_RESPONSE_BYTES) throw new Error('Upstream response too large')
      chunks.push(Buffer.from(value))
    }
  } finally {
    if (!complete) { try { void reader.cancel().catch(() => {}) } catch {} }
    reader.releaseLock()
  }
}
function readDictationRequest(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const length = req.headers['content-length']
    if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > DICTATION_MAX_REQUEST_BYTES)) {
      req.pause(); reject(new DictationInputError(413)); return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (status: number) => { cleanup(); req.pause(); reject(new DictationInputError(status)) }
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > DICTATION_MAX_REQUEST_BYTES) fail(413)
      else chunks.push(Buffer.from(chunk))
    }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)) }
    const onError = () => fail(400)
    const onAbort = () => fail(408)
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onError)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
// Keep these bounds scoped to the imported NineRouter route, not the existing Codex OAuth transport.
export async function handleNineRouterDictation(req: IncomingMessage, res: ServerResponse, apiKey: string | undefined): Promise<void> {
  const signal = AbortSignal.timeout(DICTATION_DEADLINE_MS)
  let result: { status: number; body: string }
  try {
    const body = await readDictationRequest(req, signal)
    result = await proxyNineRouterDictation(body, req.headers['content-type'] ?? '', apiKey, fetch, signal)
  } catch (error) {
    const status = error instanceof DictationInputError ? error.status : 502
    result = { status, body: JSON.stringify({ error: status === 413 ? 'Dictation request too large' : status === 408 ? 'Dictation request timed out' : 'Invalid dictation request' }) }
  }
  res.statusCode = result.status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  if (!req.complete) {
    res.setHeader('Connection', 'close')
    res.once('finish', () => { req.on('error', () => {}); req.destroy() })
  }
  res.end(result.body)
}

// Browser dictation accepts only file/language; the server alone chooses the model.
function buildDictationBody(body: Buffer, contentType: string): Buffer {
  if (contentType.length > 200 || /[\r\n]/u.test(contentType)) throw new Error('Invalid multipart')
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,.\/:=?-]{1,70})"|([0-9A-Za-z'()+_,.\/:=?-]{1,70}))\s*$/iu.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary) throw new Error('Invalid multipart')
  const delimiter = Buffer.from(`--${boundary}\r\n`)
  const separator = Buffer.from(`\r\n--${boundary}`)
  const retained: Buffer[] = []
  let cursor = delimiter.length
  let files = 0
  let languages = 0
  let parts = 0
  if (!body.subarray(0, cursor).equals(delimiter)) throw new Error('Invalid multipart')
  while (true) {
    if (++parts > 32) throw new Error('Too many fields')
    let end = body.indexOf(separator, cursor)
    while (end >= 0) {
      const suffix = body.subarray(end + separator.length, end + separator.length + 2).toString('ascii')
      if (suffix === '--' || suffix === '\r\n') break
      end = body.indexOf(separator, end + separator.length)
    }
    if (end < 0) throw new Error('Incomplete multipart')
    const part = body.subarray(cursor, end)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd < 0 || headerEnd > 8192) throw new Error('Invalid headers')
    const headers = new Map<string, string>()
    for (const line of part.subarray(0, headerEnd).toString('latin1').split('\r\n')) {
      const header = /^([A-Za-z-]+):[ \t]*([^\r\n\x00-\x08\x0b\x0c\x0e-\x1f]*)$/u.exec(line)
      const key = header?.[1]?.toLowerCase()
      if (!header || !key || headers.has(key) || !['content-disposition', 'content-type'].includes(key)) throw new Error('Invalid headers')
      headers.set(key, header[2])
    }
    const disposition = headers.get('content-disposition') ?? ''
    if (!/^form-data(?:;\s*(?:name|filename)="[^"\r\n]*"){1,2}$/iu.test(disposition)) throw new Error('Invalid disposition')
    const parameters = new Map<string, string>()
    for (const param of disposition.matchAll(/;\s*(name|filename)="([^"\r\n]*)"/giu)) {
      const key = param[1].toLowerCase()
      if (parameters.has(key)) throw new Error('Duplicate parameter')
      parameters.set(key, param[2])
    }
    const name = parameters.get('name')
    const value = part.subarray(headerEnd + 4)
    if (name === 'file') {
      if (++files !== 1 || !parameters.get('filename') || value.length === 0) throw new Error('Invalid file')
      const media = headers.get('content-type') ?? 'application/octet-stream'
      if (!/^(?:audio\/[A-Za-z0-9.+-]+|video\/(?:webm|mp4)|application\/(?:ogg|octet-stream))(?:;[ -~]*)?$/iu.test(media)) throw new Error('Invalid audio type')
      retained.push(delimiter, part, Buffer.from('\r\n'))
    } else if (name === 'language') {
      if (++languages !== 1 || parameters.has('filename') || value.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value.toString('utf8'))) throw new Error('Invalid language')
      retained.push(delimiter, part, Buffer.from('\r\n'))
    } else if (name !== 'model' || parameters.has('filename')) throw new Error('Unsupported field')
    cursor = end + separator.length + 2
    if (body.subarray(end + separator.length, cursor).equals(Buffer.from('--'))) {
      const tail = body.subarray(cursor)
      if (tail.length !== 0 && !tail.equals(Buffer.from('\r\n'))) throw new Error('Invalid closing boundary')
      break
    }
  }
  if (files !== 1) throw new Error('Missing file')
  return Buffer.concat([delimiter, Buffer.from('Content-Disposition: form-data; name="model"\r\n\r\ncx/codex-dictation\r\n'), ...retained, Buffer.from(`--${boundary}--\r\n`)])
}

export async function proxyNineRouterDictation(
  body: Buffer,
  contentType: string,
  apiKey: string | undefined,
  request: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(DICTATION_DEADLINE_MS),
): Promise<{ status: number; body: string }> {
  if (body.length > DICTATION_MAX_REQUEST_BYTES) return { status: 413, body: JSON.stringify({ error: 'Dictation request too large' }) }
  let forwardedBody: Buffer
  try { forwardedBody = buildDictationBody(body, contentType) } catch {
    return { status: 400, body: JSON.stringify({ error: 'Invalid multipart form data' }) }
  }
  try {
    const token = apiKey?.trim() ?? ''
    const operation = request(`${getNinerouterBaseUrl()}/audio/transcriptions`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': contentType },
      body: new Uint8Array(forwardedBody),
      redirect: 'error',
      signal,
    })
    // A synthetic/transport implementation may ignore abort; cancel a late response too.
    void operation.then(response => { if (signal.aborted) cancelDictationBody(response.body) }, () => {})
    const response = await awaitDictationOperation(operation, signal)
    if (response.status === 400) {
      // Released NineRouter versions currently do not implement Codex STT. Never alias to a paid provider.
      cancelDictationBody(response.body)
      return { status: 503, body: JSON.stringify({ error: 'NineRouter dictation is unavailable' }) }
    }
    const payload: unknown = JSON.parse(await readDictationResponse(response, signal))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || 'error' in payload) throw new Error('Invalid transcription')
    const result = payload as Record<string, unknown>
    if (typeof result.text === 'string') return { status: 200, body: JSON.stringify({ text: result.text }) }
    if (typeof result.transcription === 'string') return { status: 200, body: JSON.stringify({ transcription: result.transcription }) }
    throw new Error('Invalid transcription')
  } catch {
    return { status: signal.aborted ? 504 : 502, body: JSON.stringify({ error: signal.aborted ? 'NineRouter transcription timed out' : 'NineRouter transcription failed' }) }
  }
}
