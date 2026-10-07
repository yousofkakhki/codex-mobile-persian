import { request as httpRequest, createServer as createNodeServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createAppServer } from './httpServer'

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

let nodeServer: ReturnType<typeof createNodeServer> | undefined
let appServer: ReturnType<typeof createAppServer> | undefined
let codexHome: string | undefined

function request(port: number, headers: Record<string, string> = {}, method = 'GET', body?: string, path = '/codex-api/owner/authorization'): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function listen(server: ReturnType<typeof createNodeServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind TCP port')
  return address.port
}

afterEach(async () => {
  appServer?.dispose()
  appServer = undefined
  if (nodeServer?.listening) await new Promise<void>((resolve) => nodeServer!.close(() => resolve()))
  nodeServer = undefined
  if (codexHome) rmSync(codexHome, { recursive: true, force: true })
  codexHome = undefined
})

describe('owner authorization endpoint', () => {
  it('rejects loopback app-server bypasses and accepts an authenticated owner cookie', async () => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-owner-endpoint-'))
    process.env.CODEX_HOME = codexHome
    appServer = createAppServer({ password: 'test-password' })
    nodeServer = createNodeServer(appServer.app)
    const port = await listen(nodeServer)

    const loopbackBypass = await request(port, { Host: `127.0.0.1:${port}` })
    expect(loopbackBypass.status).toBe(403)
    expect(JSON.parse(loopbackBypass.body)).toEqual({ authorized: false })

    const login = await request(
      port,
      { Host: 'code.example.test', 'Content-Type': 'application/json' },
      'POST',
      JSON.stringify({ password: 'test-password' }),
      '/auth/login',
    )
    expect(login.status).toBe(200)
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0]
    expect(cookie).toMatch(/^portal_session=/)

    const owner = await request(port, { Host: 'code.example.test', Cookie: cookie })
    expect(owner.status).toBe(200)
    expect(JSON.parse(owner.body)).toEqual({ authorized: true })
  })
})
