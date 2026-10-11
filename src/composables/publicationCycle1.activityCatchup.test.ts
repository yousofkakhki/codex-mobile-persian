import { afterEach, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useThreadActivity } from './useThreadActivity'
import type { ActivityEntry, ActivityPage } from '../types/activity'

const api = vi.hoisted(() => ({ getThreadActivity: vi.fn() }))
vi.mock('../api/threadActivity', () => api)
vi.mock('../api/codexGateway', () => ({ subscribeCodexNotifications: vi.fn(() => vi.fn()) }))
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const coverage = { recordingSince: null, recoveredHistory: false, recoveryCursor: null, recoveryComplete: true, warning: null }
function entry(sequence: number, threadId = 'a'): ActivityEntry {
  return { id: 'item-' + sequence, threadId, sequence, turnId: null, itemId: null, goalCreatedAt: null, kind: 'command', status: 'completed', title: 'Synthetic', summary: '', startedAt: null, updatedAt: '', durationMs: null, hasDetail: false, reconstructed: false }
}
function page(sequence: number, more: boolean, count = 1): ActivityPage {
  return { entries: Array.from({ length: count }, (_, index) => entry(sequence - count + index + 1)), resumeCursor: String(sequence), nextCursor: more ? String(sequence) : null, coverage }
}
async function fixture() {
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn() } })
  const thread = ref('a')
  const state = useThreadActivity(thread, ref(false))
  api.getThreadActivity.mockResolvedValueOnce(page(1, false))
  state.setView('activity')
  await nextTick()
  await state.refresh()
  api.getThreadActivity.mockReset()
  return { thread, state }
}

it('PUB-ACT-03 limits automatic reconnect pages and pauses until explicit continuation', async () => {
  const { state } = await fixture()
  let pages = 0
  api.getThreadActivity.mockImplementation(async () => { pages++; return page(pages + 1, pages < 20) })
  state.applyNotification({ method: 'ready', params: {}, atIso: '' })
  await state.refresh()
  expect(pages <= 4).toBe(true)
  const pausedAt = pages
  state.applyNotification({ method: 'ready', params: {}, atIso: '' })
  await nextTick()
  expect(pages).toBe(pausedAt)
  await state.refresh()
  expect(pages > pausedAt && pages <= pausedAt + 4).toBe(true)
})

it('PUB-ACT-03 stops paging and discards an outstanding page as soon as Activity is hidden', async () => {
  const { state } = await fixture()
  let pages = 0
  api.getThreadActivity.mockImplementation(async () => { pages++; if (pages === 1) state.setView('chat'); return page(pages + 1, pages < 10) })
  await state.refresh()
  expect(pages).toBe(1)
  expect(state.entries.value.map(value => value.sequence)).toEqual([1])
  expect(state.loading.value).toBe(false)
  await state.older()
  await state.recover()
  expect(pages).toBe(1)
})

it('PUB-ACT-03 ignores a hidden-then-reopened generation while allowing the new request to complete', async () => {
  const { state } = await fixture()
  let release!: (value: ActivityPage) => void
  api.getThreadActivity.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const old = state.refresh()
  state.setView('chat')
  api.getThreadActivity.mockResolvedValue(page(3, false))
  state.setView('activity')
  await nextTick()
  expect(api.getThreadActivity.mock.calls.length >= 2).toBe(true)
  await state.refresh()
  release(page(2, true))
  await old
  expect(state.entries.value.some(value => value.sequence === 2)).toBe(false)
  expect(state.entries.value.some(value => value.sequence === 3)).toBe(true)
})

it('PUB-ACT-03 stops on a non-advancing resume cursor instead of draining identical pages', async () => {
  const { state } = await fixture()
  let pages = 0
  api.getThreadActivity.mockImplementation(async () => { pages++; return page(1, pages < 12) })
  await state.refresh()
  expect(pages).toBe(1)
  expect(state.error.value).toContain('cursor')
})

it('PUB-ACT-03 bounds entries and elapsed work per catchup while keeping explicit older requests single-page', async () => {
  const { state } = await fixture()
  let pages = 0
  api.getThreadActivity.mockImplementation(async () => { pages++; return page(pages * 100 + 1, pages < 10, 100) })
  await state.refresh()
  expect(pages <= 2).toBe(true)
  expect(state.entries.value.length <= 201).toBe(true)
  api.getThreadActivity.mockReset()
  // Older history only fetches one explicit page, never a background drain.
  api.getThreadActivity.mockResolvedValue(page(300, true))
  await state.older()
  expect(api.getThreadActivity).toHaveBeenCalledTimes(1)
})

it('PUB-ACT-03 bounds retained live entries and stops late-page application after stop or thread switch', async () => {
  const { state, thread } = await fixture()
  for (let sequence = 2; sequence <= 1600; sequence++) state.applyNotification({ method: 'activity/updated', params: { threadId: 'a', entry: entry(sequence) }, atIso: '' })
  expect(state.entries.value.length <= 1000).toBe(true)
  let release!: (value: ActivityPage) => void
  api.getThreadActivity.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = state.refresh()
  state.stop()
  release(page(1700, true))
  await pending
  expect(state.entries.value.some(value => value.sequence === 1700)).toBe(false)
  thread.value = 'b'
  expect(state.entries.value).toEqual([])
})

it('PUB-ACT-03 reloads acknowledged recent entries that were evicted by explicit earlier paging', async () => {
  const { state } = await fixture()
  state.entries.value = Array.from({ length: 1000 }, (_, index) => entry(index + 101))
  api.getThreadActivity.mockResolvedValueOnce(page(100, true, 100))
  await state.older()
  expect(state.entries.value.some(value => value.sequence === 1100)).toBe(false)
  api.getThreadActivity.mockImplementation(async (_id, options) => options.since ? page(1100, false, 0) : page(1100, true, 50))
  await state.refresh()
  expect(state.entries.value.some(value => value.sequence === 1100)).toBe(true)
})

it('PUB-ACT-03 keeps an explicitly recovered reconstructed page in the bounded earlier window', async () => {
  const { state } = await fixture()
  state.entries.value = Array.from({ length: 1000 }, (_, index) => entry(index + 1))
  const recovered = { ...entry(1001), id: 'recovered', reconstructed: true, historyOrder: -1 }
  api.getThreadActivity.mockResolvedValueOnce({ ...page(1001, true, 0), entries: [recovered] })
  await state.recover()
  expect(state.entries.value.some(value => value.id === 'recovered')).toBe(true)
  expect(state.entries.value.length <= 1000).toBe(true)
})

it('PUB-ACT-03 pauses after the first slow page without starting further automated work', async () => {
  const { state } = await fixture()
  const clock = vi.spyOn(performance, 'now')
  clock.mockReturnValueOnce(0).mockReturnValue(1100)
  let pages = 0
  api.getThreadActivity.mockImplementation(async () => { pages++; return page(pages + 1, pages < 8) })
  await state.refresh()
  expect(pages).toBe(1)
  clock.mockRestore()
})

it('PUB-ACT-03 reserves an entire bounded next page instead of overshooting its 200-entry budget', async () => {
  const { state } = await fixture()
  let pages = 0
  api.getThreadActivity.mockImplementation(async () => { pages++; return page(pages * 100 + 1, pages < 8, pages === 1 ? 1 : 100) })
  await state.refresh()
  expect(state.entries.value.length <= 201).toBe(true) // Initial one + at most 200 catchup entries.
})
