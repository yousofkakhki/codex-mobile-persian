import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleUnifiedResponsesProxyRequest } from './unifiedResponsesProxy.js'

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
      if (!options.baseUrl.trim()) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Missing custom endpoint base URL' } }))
        return
      }

      const upstreamUrl = buildModelsEndpoint(options.baseUrl, req.url)
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`
      const response = await fetch(upstreamUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(8_000),
      })
      const body = Buffer.from(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') ?? 'application/json'
      res.writeHead(response.status, {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Custom endpoint models request failed'
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message } }))
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
