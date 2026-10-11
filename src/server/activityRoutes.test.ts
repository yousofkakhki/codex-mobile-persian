import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ActivityStore } from './activityStore'
import { ActivityRecorder } from './activityRecorder'
import { handleActivityRoutes } from './activityRoutes'

describe('activity HTTP endpoints', () => {
  it('pages and reads details without resuming a thread or fetching full history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-activity-routes-test-'))
    try {
      const store = new ActivityStore(directory)
      const recorder = new ActivityRecorder(store)
      const rpc = vi.fn(async () => ({ data: [], nextCursor: null }))
      let body = ''
      const response = { statusCode: 0, setHeader: vi.fn(), end: (value: string) => { body = value } } as unknown as ServerResponse
      const request = { method: 'GET' } as IncomingMessage
      expect(await handleActivityRoutes(request, response, new URL('http://localhost/codex-api/thread-activity?threadId=a'), store, recorder, { rpc })).toBe(true)
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(body).coverage.recoveryComplete).toBe(true)
      expect(rpc).toHaveBeenCalledWith('thread/items/list', { threadId: 'a', limit: 100, sortDirection: 'desc' })
      rpc.mockClear()
      await handleActivityRoutes(request, response, new URL('http://localhost/codex-api/thread-activity?threadId=a&since=0'), store, recorder, { rpc })
      expect(rpc).not.toHaveBeenCalled()
      await handleActivityRoutes(request, response, new URL('http://localhost/codex-api/thread-activity?threadId=a&cursor=1&since=1'), store, recorder, { rpc })
      expect(response.statusCode).toBe(400)
      await store.setDetail('a', 'fixture', 'Synthetic detail')
      await handleActivityRoutes(request, response, new URL('http://localhost/codex-api/thread-activity-detail?threadId=a&entryId=fixture'), store, recorder, { rpc })
      expect(JSON.parse(body).text).toBe('Synthetic detail')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
