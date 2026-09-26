import { afterEach, describe, expect, it } from "vitest"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { createAuthSession } from "./authMiddleware"

type TestHttpResponse = {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<TestHttpResponse> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }))
    })
    req.on("error", reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const originalCodexHome = process.env.CODEX_HOME
let server: ReturnType<typeof createServer> | undefined

afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  server = undefined
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
})

describe("auth middleware behind a reverse proxy", () => {
  it("keeps loopback upstream requests protected and authorizes the issued cookie", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const home = mkdtempSync(join(tmpdir(), "codex-auth-test-"))
    process.env.CODEX_HOME = home
    try {
      const app = await import("express")
      const express = app.default
      const web = express()
      web.use(createAuthSession("test-password").middleware)
      web.get("/api/private", (_req, res) => res.json({ ok: true }))
      server = createServer(web)
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server did not bind TCP port")
      const base = `http://127.0.0.1:${address.port}`
      const anonymous = await request(`${base}/api/private`, { headers: { Host: "code.example.test" } })
      expect(anonymous.status).toBe(200)
      expect(anonymous.headers["content-type"]).toContain("text/html")
      const login = await request(`${base}/auth/login`, {
        method: "POST",
        headers: { Host: "code.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({ password: "test-password" }),
      })
      expect(login.status).toBe(200)
      const cookie = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0]
      expect(cookie).toMatch(/^portal_session=/)
      const authorized = await request(`${base}/api/private`, { headers: { Host: "code.example.test", Cookie: cookie } })
      expect(authorized.status).toBe(200)
      expect(authorized.headers["content-type"]).toContain("application/json")
      expect(JSON.parse(authorized.body)).toEqual({ ok: true })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("authorizes loopback app-server requests for localhost hosts but not proxied public hosts", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const home = mkdtempSync(join(tmpdir(), "codex-auth-proxy-test-"))
    process.env.CODEX_HOME = home
    try {
      const app = await import("express")
      const express = app.default
      const web = express()
      web.use(createAuthSession("test-password").middleware)
      web.get("/api/private", (_req, res) => res.json({ ok: true }))
      server = createServer(web)
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server did not bind TCP port")
      const base = `http://127.0.0.1:${address.port}`

      const internal = await request(`${base}/api/private`, {
        headers: { Host: `127.0.0.1:${address.port}` },
      })
      expect(internal.status).toBe(200)
      expect(JSON.parse(internal.body)).toEqual({ ok: true })

      const publicPath = await request(`${base}/api/private`, {
        headers: { Host: "code.example.test" },
      })
      expect(publicPath.status).toBe(200)
      expect(publicPath.headers["content-type"]).toContain("text/html")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
