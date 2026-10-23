import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir) }
})

let codexHome = ''

class TestResponse extends Writable {
  statusCode = 200
  body = ''

  setHeader(): this {
    return this
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.body += chunk.toString('utf8')
    callback()
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  codexHome = await mkdtemp(join(tmpdir(), 'project-directory-errors-'))
  vi.stubEnv('CODEX_HOME', codexHome)
  await writeFile(join(codexHome, 'telegram-bridge.json'), '{}', 'utf8')
  vi.stubGlobal('__codexRemoteSharedBridge__', {
    version: 'experimental-api-v2',
    appServer: { rpc: vi.fn(async () => ({})) },
    terminalManager: {},
    methodCatalog: {},
    telegramBridge: {},
    backendQueueProcessor: {},
  })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (codexHome) await rm(codexHome, { recursive: true, force: true })
  codexHome = ''
})

describe('project directory permission errors', () => {
  it.each([
    { route: '/codex-api/project-root', payload: { path: '/srv/projects/aiassistant', createIfMissing: true }, code: 'EACCES' },
    { route: '/codex-api/project-root', payload: { path: '/srv/projects/aiassistant', createIfMissing: true }, code: 'EPERM' },
    { route: '/codex-api/local-directory', payload: { path: '/srv/projects/aiassistant' }, code: 'EACCES' },
    { route: '/codex-api/local-directory', payload: { path: '/srv/projects/aiassistant' }, code: 'EPERM' },
  ])('returns an actionable permission response for $route ($code)', async ({ route, payload, code }) => {
    const mkdir = vi.mocked(fsPromises.mkdir).mockRejectedValueOnce(
      Object.assign(new Error('permission failure'), { code }) as never,
    )
    const request = Readable.from([JSON.stringify(payload)])
    Object.assign(request, { method: 'POST', url: route, headers: {} })
    const response = new TestResponse()
    const next = vi.fn()

    await createCodexBridgeMiddleware()(request as IncomingMessage, response as unknown as ServerResponse, next)

    expect(next).not.toHaveBeenCalled()
    expect(mkdir).toHaveBeenCalledExactlyOnceWith('/srv/projects/aiassistant', { recursive: true })
    expect(response.statusCode).toBe(403)
    expect(JSON.parse(response.body)).toEqual({
      error: 'The app cannot create a project in this folder. Choose a folder the app user can write to.',
    })
    expect(response.body).not.toContain('/srv/projects/aiassistant')
  })
})
