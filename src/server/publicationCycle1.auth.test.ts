import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { createAuthSession } from './authMiddleware'
import { createServer as createWebServer } from './httpServer'

const servers: Server[] = []
const homes: string[] = []
const savedCodexHome = process.env.CODEX_HOME
function privateHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'cycle1-auth-'))
  homes.push(home)
  process.env.CODEX_HOME = home
}
async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Auth fixture did not bind loopback')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
})
const PASSWORD = 'SYNTHETIC_NON_SECRET_OWNER_PASSWORD'

describe('publication cycle 1 owner login', () => {
  it('PUB-AUTH-01 actual password-enabled HTTP server permits owner read only with issued cookie', async () => {
    privateHome()
    const web = createWebServer({ password: PASSWORD })
    try {
      const base = await listen(createServer(web.app))
      expect((await fetch(`${base}/codex-api/owner/authorization`)).status).toBe(403)
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
      })
      expect(login.status).toBe(200)
      expect(await login.json()).toEqual({ ok: true })
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!
      const owner = await fetch(`${base}/codex-api/owner/authorization`, { headers: { Cookie: cookie } })
      expect(owner.status).toBe(200)
      expect(await owner.json()).toEqual({ authorized: true })
      const internal = await fetch(`${base}/codex-api/owner/authorization`)
      expect(internal.status).toBe(403)
      expect(await internal.json()).toEqual({ authorized: false })
    } finally { await web.dispose() }
  })

  it('PUB-AUTH-01 wrong local password cannot mint a cookie or owner authorization', async () => {
    privateHome()
    const auth = createAuthSession(PASSWORD)
    const app = express()
    app.use(auth.middleware)
    app.get('/owner', (req, res) => res.status(auth.isOwnerAuthorized(req) ? 200 : 403).json({ authorized: auth.isOwnerAuthorized(req) }))
    const base = await listen(createServer(app))
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'WRONG_SYNTHETIC_PASSWORD' }),
    })
    expect(login.status).toBe(401)
    expect(login.headers.get('set-cookie')).toBeNull()
    expect((await fetch(`${base}/owner`)).status).toBe(403)
  })

  it('PUB-AUTH-01 trusted Tailscale and loopback requests remain nonowners without a valid cookie', () => {
    privateHome()
    const auth = createAuthSession(PASSWORD)
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.10.20', 'fd7a:115c:a1e0::1']) {
      const req = { socket: { remoteAddress: remote }, headers: { host: 'localhost:5900', cookie: 'portal_session=FORGED_NON_SECRET_COOKIE' } } as never
      expect(auth.isRequestAuthorized(req)).toBe(true)
      expect(auth.isOwnerAuthorized(req)).toBe(false)
    }
    const proxied = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'code.example.test' } } as never
    expect(auth.isRequestAuthorized(proxied)).toBe(false)
    expect(auth.isOwnerAuthorized(proxied)).toBe(false)
  })
  it('PUB-AUTH-01 explicit localhost password login issues cookie before trusted internal bypass', async () => {
    privateHome()
    const auth = createAuthSession(PASSWORD)
    const app = express()
    app.use(auth.middleware)
    app.post('/auth/login', (_req, res) => res.status(404).json({ skippedLogin: true }))
    app.get('/owner', (req, res) => res.status(auth.isOwnerAuthorized(req) ? 200 : 403).json({ authorized: auth.isOwnerAuthorized(req) }))
    const base = await listen(createServer(app))
    const before = await fetch(`${base}/owner`)
    expect(before.status).toBe(403)
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    expect(await login.json()).toEqual({ ok: true })
    const cookieHeader = login.headers.get('set-cookie') ?? ''
    const cookie = cookieHeader.split(';')[0]!
    expect(cookie).toMatch(/^portal_session=[0-9a-f]{64}$/u)
    expect(cookieHeader).toContain('HttpOnly')
    expect(cookieHeader).toContain('SameSite=Lax')
    expect((await fetch(`${base}/owner`, { headers: { Cookie: cookie } })).status).toBe(200)
    expect((await fetch(`${base}/owner`)).status).toBe(403)
  })
})
