import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { handleCustomEndpointModelsRequest } from './customEndpointProxy'

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('test server did not bind to a TCP port'))
    })
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

describe('custom endpoint models proxy', () => {
  it('forwards the models request and preserves the OpenAI-compatible response', async () => {
    let upstreamUrl = ''
    let upstreamAuthorization = ''
    const upstream = createServer((req, res) => {
      upstreamUrl = req.url ?? ''
      upstreamAuthorization = String(req.headers.authorization ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'cx/gpt-6-luna', object: 'model', owned_by: 'custom' }],
      }))
    })
    const upstreamPort = await listen(upstream)

    const proxy = createServer((req, res) => {
      handleCustomEndpointModelsRequest(req, res, {
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        bearerToken: 'upstream-token',
      })
    })
    const proxyPort = await listen(proxy)

    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?client_version=0.154.0`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({
        object: 'list',
        data: [{ id: 'cx/gpt-6-luna', object: 'model', owned_by: 'custom' }],
      })
      expect(upstreamUrl).toBe('/v1/models?client_version=0.154.0')
      expect(upstreamAuthorization).toBe('Bearer upstream-token')
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })
})
