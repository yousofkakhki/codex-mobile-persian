import { describe, expect, it, vi } from 'vitest'
import { listThreadTurnsPage, sanitizeThreadTurnsInlinePayloads } from './codexAppServerBridge'

describe('cursor-based thread turn pages', () => {
  it('forwards the opaque cursor to the app-server descending full-items page API', async () => {
    const rpc = vi.fn(async () => ({ data: [], nextCursor: null, backwardsCursor: null }))
    const appServer = { rpc }

    await listThreadTurnsPage(appServer, 'thread-1', 'opaque+cursor/1', 10)

    expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/turns/list', {
      threadId: 'thread-1',
      cursor: 'opaque+cursor/1',
      limit: 10,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.anything())
  })

  it('keeps cursor metadata while sanitizing page turns in data', async () => {
    const input = { data: [], nextCursor: 'next', backwardsCursor: 'back' }
    await expect(sanitizeThreadTurnsInlinePayloads('thread/turns/list', input)).resolves.toBe(input)
  })
})