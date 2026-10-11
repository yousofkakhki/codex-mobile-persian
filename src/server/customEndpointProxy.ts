import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleUnifiedResponsesProxyRequest } from './unifiedResponsesProxy.js'

const MODELS_MAX_RESPONSE_BYTES = 1024 * 1024

async function awaitModelsOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Models request cancelled'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function readModelsBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) throw new Error('Missing models body')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await awaitModelsOperation(reader.read(), signal)
      if (done) {
        complete = true
        return Buffer.concat(chunks, bytes)
      }
      bytes += value.byteLength
      if (bytes > MODELS_MAX_RESPONSE_BYTES) throw new Error('Models response limit exceeded')
      chunks.push(Buffer.from(value))
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function writeModelsJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function joinEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`
}

function buildModelsEndpoint(baseUrl: string, requestUrl: string | undefined): URL {
  const upstreamUrl = new URL(joinEndpoint(baseUrl, '/models'))
  const incomingUrl = new URL(requestUrl ?? '/models', 'http://localhost')
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    upstreamUrl.searchParams.set(key, value)
  }
  return upstreamUrl
}

export function handleCustomEndpointModelsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    baseUrl: string
    bearerToken: string
  },
): void {
  void (async () => {
    try {
      if (!options.baseUrl.trim()) throw new Error('Missing models endpoint')
      const upstreamUrl = buildModelsEndpoint(options.baseUrl, req.url)
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`
      const signal = AbortSignal.timeout(8_000)
      const response = await awaitModelsOperation(fetch(upstreamUrl, {
        method: 'GET',
        redirect: 'error',
        headers,
        signal,
      }), signal)
      const contentType = response.headers.get('content-type') ?? ''
      if (!response.ok || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        void response.body?.cancel().catch(() => {})
        throw new Error('Invalid models media type')
      }
      const payload: unknown = JSON.parse((await readModelsBody(response, signal)).toString('utf8'))
      const catalog = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      if (!Array.isArray(catalog?.data) || catalog.data.some(value => (
        value === null || typeof value !== 'object' || Array.isArray(value)
        || typeof (value as Record<string, unknown>).id !== 'string'
        || !(value as Record<string, unknown>).id
      ))) throw new Error('Invalid models catalog')
      writeModelsJson(res, response.status, catalog)
    } catch {
      // Transport errors and provider bodies can contain credential-bearing URLs.
      if (!res.headersSent) {
        writeModelsJson(res, 502, { error: { message: 'Custom endpoint models request failed' } })
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })()
}

export function handleCustomEndpointProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    baseUrl: string
    bearerToken: string
    wireApi: 'responses' | 'chat'
  },
): void {
  handleUnifiedResponsesProxyRequest(req, res, {
    bearerToken: options.bearerToken,
    wireApi: options.wireApi,
    responsesEndpoint: joinEndpoint(options.baseUrl, '/responses'),
    chatCompletionsEndpoint: joinEndpoint(options.baseUrl, '/chat/completions'),
    missingKeyMessage: 'Missing custom endpoint API key',
    allowToolFallbackToResponses: false,
  })
}
