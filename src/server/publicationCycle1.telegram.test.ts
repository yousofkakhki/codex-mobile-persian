import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramThreadBridge } from './telegramThreadBridge'

type Notification = { method: string; params: unknown }
type TestBridge = { handleNotification: (notification: Notification) => Promise<void> }
function fixture(turns: Record<string, unknown>[]) {
  const rpc = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'thread/read') return { thread: { id: 'exact-thread', name: 'Bound completion fixture', model: 'LATEST-THREAD-MODEL', turns } }
    if (method === 'thread/items/list') {
      const turn = turns.find(value => value.id === (params as Record<string, unknown>).turnId)
      const items = Array.isArray(turn?.items) ? turn.items : []
      return { data: [...items].reverse().map(item => ({ turnId: turn?.id, item })), nextCursor: null }
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  const sent: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    if (!String(input).endsWith('/sendMessage')) throw new Error('No genuine Telegram request is permitted')
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return Response.json({ ok: true, result: [] })
  }))
  const bridge = new TelegramThreadBridge({ rpc, onNotification: () => () => {} })
  bridge.configureToken('NON-SECRET-BOT-FIXTURE')
  bridge.configureNotificationChatIds([111])
  return { bridge, rpc, sent, complete: (turn: Record<string, unknown>, extra: Record<string, unknown> = {}) => (
    (bridge as unknown as TestBridge).handleNotification({ method: 'turn/completed', params: { threadId: 'exact-thread', turnId: turn.id, turn, ...extra } })
  ) }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('publication cycle 1 exact-turn Telegram completion', () => {
  it('PUB-TELEGRAM-01 reaches exact final output on the next bounded item page', async () => {
    const f = fixture([])
    f.rpc.mockImplementation(async (method, params) => {
      if (method === 'thread/read') return { thread: { id: 'exact-thread', name: 'Bound completion fixture', turns: [] } }
      const cursor = (params as Record<string, unknown>).cursor
      return cursor === undefined
        ? { data: [{ turnId: 'paged-turn', item: { type: 'agentMessage', phase: 'commentary', text: 'NON-FINAL-COMMENTARY' } }], nextCursor: 'opaque+cursor/1' }
        : { data: [{ turnId: 'paged-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'SECOND-PAGE-FINAL-OUTPUT' } }], nextCursor: null }
    })
    await f.complete({ id: 'paged-turn', status: 'completed', itemsView: 'notLoaded', items: [] })
    expect(f.sent[0]!.text).toContain('SECOND-PAGE-FINAL-OUTPUT')
    expect(f.sent[0]!.text).not.toContain('NON-FINAL-COMMENTARY')
    expect(f.rpc.mock.calls).toEqual([
      ['thread/read', { threadId: 'exact-thread', includeTurns: false }],
      ['thread/items/list', { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc' }],
      ['thread/items/list', { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc', cursor: 'opaque+cursor/1' }],
    ])
  })
  it('PUB-TELEGRAM-01 stops repeated opaque cursors and reports an incomplete exact-turn lookup', async () => {
    const f = fixture([])
    f.rpc.mockImplementation(async method => method === 'thread/read'
      ? { thread: { id: 'exact-thread', turns: [] } }
      : { data: [], nextCursor: 'opaque+same/1', backwardsCursor: null })
    await f.complete({ id: 'paged-turn', status: 'completed', itemsView: 'notLoaded', items: [] })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('پاسخ نهایی این نوبت بازیابی نشد')
    expect(f.rpc.mock.calls.filter(([method]) => method === 'thread/items/list')).toEqual([
      ['thread/items/list', { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc' }],
      ['thread/items/list', { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc', cursor: 'opaque+same/1' }],
    ])
  })
  it('PUB-TELEGRAM-01 bounds stalled metadata while preserving an exactly bound event response', async () => {
    vi.useFakeTimers()
    const f = fixture([])
    f.rpc.mockImplementation(() => new Promise<unknown>(() => {}))
    let finished = false
    void f.complete({ id: 'event-turn', status: 'completed', itemsView: 'full', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'EXACT-EVENT-OUTPUT' }] }).then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(finished).toBe(true)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('EXACT-EVENT-OUTPUT')
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 'exact-thread', includeTurns: false })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('PUB-TELEGRAM-01 pages summary event items instead of declaring an exact turn empty', async () => {
    const f = fixture([{ id: 'paged-turn', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'FULL-PAGED-FINAL' }] }])
    await f.complete({ id: 'paged-turn', status: 'completed', itemsView: 'summary', items: [] })
    expect(f.sent[0]!.text).toContain('FULL-PAGED-FINAL')
    expect(f.rpc).toHaveBeenCalledWith('thread/items/list', { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc' })
  })
  it('PUB-TELEGRAM-01 stops after three pages of 100 items with a safe incomplete message', async () => {
    const f = fixture([])
    let pages = 0
    f.rpc.mockImplementation(async method => {
      if (method === 'thread/read') return { thread: { id: 'exact-thread', turns: [] } }
      const page = ++pages
      return { data: Array.from({ length: 100 }, (_, index) => ({ turnId: 'paged-turn', item: { type: 'reasoning', id: `reasoning-${page}-${index}`, summary: [], content: [] } })), nextCursor: `opaque+cursor/${page}`, backwardsCursor: null }
    })
    await f.complete({ id: 'paged-turn', status: 'completed', itemsView: 'notLoaded', items: [] })
    expect(pages).toBe(3)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('پاسخ نهایی این نوبت بازیابی نشد')
    expect(f.rpc.mock.calls.filter(([method]) => method === 'thread/items/list').map(([, params]) => params)).toEqual([
      { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc' },
      { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc', cursor: 'opaque+cursor/1' },
      { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc', cursor: 'opaque+cursor/2' },
    ])
  })
  it('PUB-TELEGRAM-01 accepts an exact final answer at the last allowed item before stopping', async () => {
    const f = fixture([])
    let pages = 0
    f.rpc.mockImplementation(async method => {
      if (method === 'thread/read') return { thread: { id: 'exact-thread', turns: [] } }
      const page = ++pages
      const data: unknown[] = Array.from({ length: 100 }, (_, index) => ({ turnId: 'paged-turn', item: { type: 'reasoning', id: `reasoning-${page}-${index}`, summary: [], content: [] } }))
      if (page === 3) data[99] = { turnId: 'paged-turn', item: { type: 'agentMessage', id: 'last-final', phase: 'final_answer', text: 'LAST-BUDGET-EXACT-FINAL', memoryCitation: null } }
      return { data, nextCursor: `opaque+cursor/${page}`, backwardsCursor: null }
    })
    await f.complete({ id: 'paged-turn', status: 'completed', itemsView: 'notLoaded', items: [] })
    expect(pages).toBe(3)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('LAST-BUDGET-EXACT-FINAL')
    expect(f.sent[0]!.text).not.toContain('بررسی محدود کامل نشد')
  })
  it('PUB-TELEGRAM-01 rejects foreign-turn output and model on subsequent item pages', async () => {
    const f = fixture([])
    let pages = 0
    f.rpc.mockImplementation(async method => {
      if (method === 'thread/read') return { thread: { id: 'exact-thread', model: 'LATEST-THREAD-MODEL', turns: [] } }
      return ++pages === 1
        ? { data: [], nextCursor: 'opaque+cursor/1', backwardsCursor: null }
        : { data: [
          { turnId: 'later-turn', model: 'FOREIGN-ITEM-MODEL', item: { type: 'agentMessage', phase: 'final_answer', text: 'FOREIGN-TURN-OUTPUT' } },
          { turnId: 'paged-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'EXACT-SECOND-PAGE' } },
        ], nextCursor: null, backwardsCursor: null }
    })
    await f.complete({ id: 'paged-turn', status: 'completed', itemsView: 'notLoaded', items: [] })
    expect(f.sent[0]!.text).toContain('EXACT-SECOND-PAGE')
    expect(f.sent[0]!.text).not.toMatch(/FOREIGN-TURN-OUTPUT|FOREIGN-ITEM-MODEL|LATEST-THREAD-MODEL/u)
  })
  it('PUB-TELEGRAM-01 shares one deadline across pages and never sends late item results', async () => {
    vi.useFakeTimers()
    const f = fixture([])
    let resolveLate: (page: unknown) => void = () => {}
    let pages = 0
    f.rpc.mockImplementation(async method => {
      if (method === 'thread/read') return { thread: { id: 'exact-thread', turns: [] } }
      if (++pages === 1) {
        await new Promise(resolve => setTimeout(resolve, 6_000))
        return { data: [], nextCursor: 'opaque+cursor/1', backwardsCursor: null }
      }
      return new Promise(resolve => { resolveLate = resolve })
    })
    let finished = false
    const done = f.complete({ id: 'paged-turn', status: 'failed', error: { message: 'EXACT-TURN-FAILURE' }, itemsView: 'notLoaded', items: [] }).then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(finished).toBe(true)
    expect(pages).toBe(2)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('EXACT-TURN-FAILURE')
    expect(f.sent[0]!.text).toContain('پاسخ نهایی این نوبت بازیابی نشد')
    resolveLate({ data: [{ turnId: 'paged-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'LATE-EXACT-OUTPUT' } }], nextCursor: null })
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).not.toContain('LATE-EXACT-OUTPUT')
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    { nextCursor: null },
    { data: [], nextCursor: 17 },
    { data: [], nextCursor: '' },
    { data: [] },
    { data: null, nextCursor: null },
    { data: Array.from({ length: 101 }, () => ({ turnId: 'paged-turn', item: { type: 'reasoning', summary: [], content: [] } })), nextCursor: null },
  ])('PUB-TELEGRAM-01 reports malformed or over-budget item pages as incomplete %j', async page => {
    const f = fixture([])
    f.rpc.mockImplementation(async method => method === 'thread/read' ? { thread: { id: 'exact-thread', turns: [] } } : page)
    await f.complete({ id: 'paged-turn', status: 'completed', itemsView: 'notLoaded', items: [] })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('پاسخ نهایی این نوبت بازیابی نشد')
    expect(f.rpc.mock.calls.filter(([method]) => method === 'thread/items/list')).toHaveLength(1)
  })
  it('PUB-TELEGRAM-01 sends status-only completion on item lookup failure instead of borrowing history', async () => {
    const f = fixture([{ id: 'earlier', items: [{ type: 'agentMessage', text: 'EARLIER-ASSISTANT-OUTPUT' }] }])
    f.rpc.mockImplementation(async method => {
      if (method === 'thread/read') return { thread: { id: 'exact-thread', name: 'Bound completion fixture', model: 'LATEST-THREAD-MODEL', turns: [] } }
      throw new Error('SYNTHETIC-ITEM-LOOKUP-FAILURE')
    })
    await f.complete({ id: 'failed-turn', status: 'failed', error: { message: 'EXACT-TURN-FAILURE' } })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('EXACT-TURN-FAILURE')
    expect(f.sent[0]!.text).not.toMatch(/EARLIER-ASSISTANT-OUTPUT|LATEST-THREAD-MODEL|SYNTHETIC-ITEM-LOOKUP-FAILURE/u)
  })
  it('PUB-TELEGRAM-01 preserves a valid event completion when metadata read fails', async () => {
    const f = fixture([])
    f.rpc.mockRejectedValueOnce(new Error('SYNTHETIC-METADATA-FAILURE'))
    await f.complete({ id: 'event-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'EXACT-EVENT-OUTPUT' }] })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('EXACT-EVENT-OUTPUT')
    expect(f.sent[0]!.text).not.toContain('SYNTHETIC-METADATA-FAILURE')
  })
  it('PUB-TELEGRAM-01 selects final-answer text rather than later commentary within the same turn', async () => {
    const f = fixture([])
    await f.complete({ id: 'event-turn', status: 'completed', items: [
      { type: 'agentMessage', phase: 'final_answer', text: 'EXACT-FINAL-ANSWER' },
      { type: 'agentMessage', phase: 'commentary', text: 'NOT-A-FINAL-ANSWER' },
    ] })
    expect(f.sent[0]!.text).toContain('EXACT-FINAL-ANSWER')
    expect(f.sent[0]!.text).not.toContain('NOT-A-FINAL-ANSWER')
  })
  it('PUB-TELEGRAM-01 ignores metadata returned for another thread', async () => {
    const f = fixture([])
    f.rpc.mockResolvedValueOnce({ thread: { id: 'foreign-thread', name: 'FOREIGN-THREAD-TITLE', turns: [], model: 'FOREIGN-THREAD-MODEL' } })
    await f.complete({ id: 'event-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'EXACT-EVENT-OUTPUT' }] })
    expect(f.sent[0]!.text).toContain('EXACT-EVENT-OUTPUT')
    expect(f.sent[0]!.text).not.toMatch(/FOREIGN-THREAD-TITLE|FOREIGN-THREAD-MODEL/u)
  })
  it.each([
    [{ id: 'event-turn', threadId: 'foreign-thread' }, {}],
    [{ id: 'event-turn' }, { turnId: 'foreign-turn' }],
    [{ status: 'failed' }, {}],
  ])('PUB-TELEGRAM-01 ignores ambiguous or missing completion identity %j', async (turn, extra) => {
    const f = fixture([])
    await f.complete({ status: 'completed', model: 'UNBOUND-EVENT-MODEL', items: [{ type: 'agentMessage', text: 'UNBOUND-EVENT-OUTPUT' }], ...turn }, extra)
    expect(f.sent).toHaveLength(0)
    expect(f.rpc).not.toHaveBeenCalled()
  })
  it('PUB-TELEGRAM-01 retrieves missing event items using a bounded exact-turn item page', async () => {
    const f = fixture([
      { id: 'earlier', items: [{ type: 'agentMessage', text: 'EARLIER-ASSISTANT-OUTPUT' }] },
      { id: 'paged-turn', items: [{ type: 'agentMessage', text: 'EXACT-PAGED-OUTPUT' }] },
      { id: 'later', items: [{ type: 'agentMessage', text: 'LATER-ASSISTANT-OUTPUT' }] },
    ])
    await f.complete({ id: 'paged-turn', status: 'completed' })
    expect(f.sent[0]!.text).toContain('EXACT-PAGED-OUTPUT')
    expect(f.sent[0]!.text).not.toMatch(/EARLIER-ASSISTANT-OUTPUT|LATER-ASSISTANT-OUTPUT|LATEST-THREAD-MODEL/u)
    expect(f.rpc.mock.calls).toEqual([
      ['thread/read', { threadId: 'exact-thread', includeTurns: false }],
      ['thread/items/list', { threadId: 'exact-thread', turnId: 'paged-turn', limit: 100, sortDirection: 'desc' }],
    ])
  })
  it('PUB-TELEGRAM-01 prefers assistant output carried by the exactly bound completed event without hydrating history', async () => {
    const f = fixture([{ id: 'later', model: 'LATER-MODEL', items: [{ type: 'agentMessage', text: 'LATER-ASSISTANT-OUTPUT' }] }])
    await f.complete({ id: 'event-turn', status: 'completed', model: 'EVENT-MODEL', items: [{ type: 'agentMessage', text: 'EXACT-EVENT-OUTPUT' }] })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toContain('EXACT-EVENT-OUTPUT')
    expect(f.sent[0]!.text).toContain('EVENT-MODEL')
    expect(f.sent[0]!.text).not.toMatch(/LATER-ASSISTANT-OUTPUT|LATER-MODEL|LATEST-THREAD-MODEL/u)
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 'exact-thread', includeTurns: false })
  })
  it('PUB-TELEGRAM-01 never attributes earlier or later assistant text/model to an empty failed turn', async () => {
    const f = fixture([
      { id: 'earlier', model: 'EARLIER-MODEL', items: [{ type: 'agentMessage', text: 'EARLIER-ASSISTANT-OUTPUT' }] },
      { id: 'empty-failed', items: [] },
      { id: 'later', model: 'LATER-MODEL', items: [{ type: 'agentMessage', text: 'LATER-ASSISTANT-OUTPUT' }] },
    ])
    await f.complete({ id: 'empty-failed', status: 'failed', items: [], error: { message: 'EXACT-TURN-FAILURE' } })
    expect(f.sent).toHaveLength(1)
    const text = String(f.sent[0]!.text)
    expect(text).toContain('empty-failed')
    expect(text).toContain('EXACT-TURN-FAILURE')
    expect(text).not.toMatch(/EARLIER-ASSISTANT-OUTPUT|LATER-ASSISTANT-OUTPUT|EARLIER-MODEL|LATER-MODEL|LATEST-THREAD-MODEL/u)
  })
})
