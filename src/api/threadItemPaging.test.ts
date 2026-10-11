import { afterEach, describe, expect, it, vi } from 'vitest'
import { getOlderThreadMessages, getThreadDetail, resumeThread } from './codexGateway'

const olderTurn = '01900000-0000-7000-8000-000000000001'
const latestTurn = '01900000-0001-7000-8000-000000000002'

function header(id: string, status = 'completed', error: unknown = null) {
  return { id, items: [], itemsView: 'notLoaded', status, error, startedAt: null, completedAt: null, durationMs: null }
}

function item(id: string, text: string) {
  return { id, type: 'agentMessage', text, phase: 'final' }
}

function installRpc(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
    requests.push(body)
    const result = handler(body.method, body.params)
    if (result instanceof Error) return new Response(JSON.stringify({ error: result.message }), { status: 502 })
    return new Response(JSON.stringify({ result }), { status: 200 })
  }))
  return requests
}

function resumed(headers: unknown[], nextCursor: string | null = null) {
  return {
    thread: { id: 'thread', turns: [], status: { type: 'active', activeFlags: [] } },
    model: 'cx/gpt-6.1-sol', modelProvider: 'ninerouter',
    serviceTier: 'priority',
    initialTurnsPage: { data: headers, nextCursor, backwardsCursor: null },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('item-paged thread history', () => {
  it('loads headers and at most 100 recent items while keeping failed turns and active state', async () => {
    const requests = installRpc(method => method === 'thread/resume'
      ? resumed([header(latestTurn, 'inProgress'), header(olderTurn, 'failed', { message: 'previous failure' })])
      : { data: [{ turnId: latestTurn, item: item('newest', 'latest') }, { turnId: latestTurn, item: item('previous', 'previous') }], nextCursor: 'items+older/1', backwardsCursor: null })
    const detail = await resumeThread('item-paged-recent')
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'item-paged-recent', excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'notLoaded' } } },
      { method: 'thread/items/list', params: { threadId: 'item-paged-recent', limit: 100, sortDirection: 'desc' } },
    ])
    expect(detail.messages.map(message => message.text)).toEqual(['previous failure', 'previous', 'latest'])
    expect(detail.activeTurnId).toBe(latestTurn)
    expect(detail.inProgress).toBe(true)
    expect(detail.modelProvider).toBe('ninerouter')
    expect(detail.speedMode).toBe('fast')
    expect(detail.olderCursor).toBe('item-history:{"items":"items+older/1","turns":null}')
  })

  it('uses opaque item cursors for earlier items in the same large turn', async () => {
    const requests = installRpc(() => ({ data: [{ turnId: latestTurn, item: item('earlier', 'earlier item') }], nextCursor: null, backwardsCursor: null }))
    const page = await getOlderThreadMessages('large-turn', 'item-history:{"items":"opaque+cursor/1","turns":null}', 10)
    expect(requests).toEqual([{ method: 'thread/items/list', params: { threadId: 'large-turn', limit: 100, sortDirection: 'desc', cursor: 'opaque+cursor/1' } }])
    expect(page.messages[0]).toMatchObject({ id: 'earlier', turnId: latestTurn })
    expect(page.hasMoreOlder).toBe(false)
  })

  it('keeps metadata-only failed turns reachable after item pages are exhausted', async () => {
    const requests = installRpc(() => ({ data: [header(olderTurn, 'failed', { message: 'older failure' })], nextCursor: null, backwardsCursor: null }))
    const page = await getOlderThreadMessages('empty-failed-turn', 'item-history:{"items":null,"turns":"older-turn-header"}')
    expect(requests).toEqual([{ method: 'thread/turns/list', params: { threadId: 'empty-failed-turn', cursor: 'older-turn-header', limit: 10, sortDirection: 'desc', itemsView: 'notLoaded' } }])
    expect(page.messages[0]).toMatchObject({ messageType: 'turnError', text: 'older failure' })
    expect(page.nextCursor).toBeNull()
  })

  it('keeps an older cursor when the latest items contain only hidden reasoning', async () => {
    installRpc(method => method === 'thread/resume'
      ? resumed([header(latestTurn)])
      : { data: [{ turnId: latestTurn, item: { id: 'reasoning', type: 'reasoning', summary: [], content: [] } }], nextCursor: 'earlier-items', backwardsCursor: null })
    const detail = await getThreadDetail('reasoning-only-page')
    expect(detail.messages).toEqual([])
    expect(detail.hasMoreOlder).toBe(true)
  })

  it('falls back to legacy full turn pages only when item pagination is unsupported', async () => {
    const requests = installRpc(method => {
      if (method === 'thread/resume') return resumed([header(latestTurn)])
      if (method === 'thread/items/list') return new Error('unknown variant `thread/items/list`')
      return { data: [{ ...header(latestTurn), items: [item('legacy', 'legacy message')], itemsView: 'full' }], nextCursor: 'legacy-older', backwardsCursor: null }
    })
    const detail = await resumeThread('unsupported-item-store')
    expect(detail.messages[0]?.text).toBe('legacy message')
    expect(detail.olderCursor).toBe('legacy-older')
    expect(requests.at(-1)).toMatchObject({ method: 'thread/turns/list', params: { limit: 10, itemsView: 'full' } })
  })

  it('does not fall back to a huge turn read after a transient item-page failure', async () => {
    const requests = installRpc(method => method === 'thread/resume' ? resumed([header(latestTurn)]) : new Error('upstream temporarily unavailable'))
    await expect(resumeThread('failed-item-load')).rejects.toThrow('upstream temporarily unavailable')
    expect(requests.map(request => request.method)).toEqual(['thread/resume', 'thread/items/list'])
  })
})
