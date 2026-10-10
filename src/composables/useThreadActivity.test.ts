import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useThreadActivity, mergeActivityEntries } from './useThreadActivity'
import type { ActivityEntry, ActivityPage } from '../types/activity'

const api = vi.hoisted(() => ({ getThreadActivity: vi.fn() }))
vi.mock('../api/threadActivity', () => api)
vi.mock('../api/codexGateway', () => ({ subscribeCodexNotifications: vi.fn(() => vi.fn()) }))
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals() })
function entry(id: string, sequence: number, threadId = 'a'): ActivityEntry {
  return { id, sequence, threadId, turnId: 'turn', itemId: id, goalCreatedAt: null, kind: 'command', status: 'running', title: 'Fixture command', summary: '', startedAt: '2026-10-10T00:00:00.000Z', updatedAt: '', durationMs: null, hasDetail: false, reconstructed: false }
}
function page(entries: ActivityEntry[], cursor: string | null = null): ActivityPage {
  return { entries, nextCursor: cursor, resumeCursor: '10', coverage: { recordingSince: null, recoveredHistory: false, recoveryCursor: null, recoveryComplete: false, warning: null } }
}
function installWindow() {
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } })
}

describe('thread Activity state', () => {
  it('deduplicates updates without replacing a completed record with older history', () => {
    const latest = { ...entry('command', 3), status: 'completed' as const }
    expect(mergeActivityEntries([latest], [entry('command', 1)])).toEqual([latest])
    expect(mergeActivityEntries([entry('command', 1)], [latest])).toEqual([latest])
  })

  it('loads only when Activity is selected and persists the selected tab per thread', async () => {
    installWindow()
    const selected = ref('a')
    const state = useThreadActivity(selected, ref(false))
    await nextTick()
    expect(api.getThreadActivity).not.toHaveBeenCalled()
    api.getThreadActivity.mockResolvedValue(page([entry('first', 1)]))
    state.setView('activity')
    await nextTick()
    await state.refresh()
    expect(state.entries.value).toHaveLength(1)
    selected.value = 'b'
    await nextTick()
    expect(state.view.value).toBe('chat')
    expect(state.entries.value).toEqual([])
    selected.value = 'a'
    await nextTick()
    expect(state.view.value).toBe('activity')
    expect(useThreadActivity(ref('a'), ref(false)).view.value).toBe('activity')
  })

  it('rejects late pages from another thread and catches up after reconnect', async () => {
    installWindow()
    const selected = ref('a')
    const state = useThreadActivity(selected, ref(false))
    let release!: (value: ActivityPage) => void
    api.getThreadActivity.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    state.setView('activity')
    await nextTick()
    selected.value = 'b'
    release(page([entry('old', 1)]))
    await nextTick()
    expect(state.entries.value).toEqual([])
    api.getThreadActivity.mockResolvedValue(page([entry('new', 2, 'b')]))
    state.setView('activity')
    await nextTick()
    await state.refresh()
    state.applyNotification({ method: 'ready', params: {}, atIso: '' })
    await nextTick()
    expect(api.getThreadActivity).toHaveBeenLastCalledWith('b', { since: '10' })
    state.applyNotification({ method: 'activity/updated', params: { threadId: 'a', entry: entry('wrong', 4) }, atIso: '' })
    expect(state.entries.value.some(value => value.id === 'wrong')).toBe(false)
  })
})
