import { describe, expect, it, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { useThreadGoalState } from './useThreadGoalState'
import type { ThreadGoal } from '../api/codexGateway'

const api = vi.hoisted(() => ({ getThreadGoal: vi.fn(), setThreadGoal: vi.fn(), resumeThreadGoal: vi.fn(), clearThreadGoal: vi.fn() }))
vi.mock('../api/codexGateway', () => ({ ...api, normalizeThreadGoal: (value: unknown) => value, subscribeCodexNotifications: vi.fn(() => vi.fn()) }))
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })
const goal = (threadId: string): ThreadGoal => ({ threadId, objective: `Goal for ${threadId}`, status: 'complete', tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('thread-scoped goal state', () => {
  it('immediately hides the previous goal while the new thread is loading', async () => {
    const selected = ref('a'), home = ref(false)
    const state = useThreadGoalState(selected, home)
    api.getThreadGoal.mockResolvedValueOnce(goal('a'))
    await state.refresh()
    expect(state.goal.value?.threadId).toBe('a')
    selected.value = 'b'
    const next = deferred<ThreadGoal | null>()
    api.getThreadGoal.mockReturnValueOnce(next.promise)
    const loading = state.refresh()
    expect(state.goal.value).toBeNull()
    next.resolve(null)
    await loading
    expect(state.goal.value).toBeNull()
    home.value = true
    selected.value = 'a'
    expect(state.goal.value).toBeNull()
  })

  it('ignores an older read even after switching away and back to the same thread', async () => {
    const selected = ref('a'), state = useThreadGoalState(selected, ref(false))
    const old = deferred<ThreadGoal | null>()
    api.getThreadGoal.mockReturnValueOnce(old.promise)
    const first = state.refresh()
    selected.value = 'b'
    api.getThreadGoal.mockResolvedValueOnce(null)
    await state.refresh()
    selected.value = 'a'
    api.getThreadGoal.mockResolvedValueOnce({ ...goal('a'), objective: 'Latest goal' })
    await state.refresh()
    old.resolve(goal('a'))
    await first
    expect(state.goal.value?.objective).toBe('Latest goal')
  })

  it.each(['save', 'resume', 'clear'] as const)('does not apply a late %s result to another thread', async operation => {
    const selected = ref('a'), state = useThreadGoalState(selected, ref(false))
    api.getThreadGoal.mockResolvedValueOnce(goal('a'))
    await state.refresh()
    const delayed = deferred<any>()
    api.setThreadGoal.mockReturnValueOnce(delayed.promise)
    api.resumeThreadGoal.mockReturnValueOnce(delayed.promise)
    api.clearThreadGoal.mockReturnValueOnce(delayed.promise)
    const writing = operation === 'save' ? state.save({ objective: 'Edited' }) : state[operation]()
    selected.value = 'b'
    api.getThreadGoal.mockResolvedValueOnce(goal('b'))
    await state.refresh()
    delayed.resolve(operation === 'clear' ? true : goal('a'))
    expect(await writing).toBe(false)
    expect(state.goal.value?.threadId).toBe('b')
  })

  it('rejects a response belonging to a different thread', async () => {
    const state = useThreadGoalState(ref('b'), ref(false))
    api.getThreadGoal.mockResolvedValueOnce(goal('a'))
    await state.refresh()
    expect(state.goal.value).toBeNull()
    expect(state.error.value).toContain('different thread')
  })

  it('applies live usage and clear events without allowing an older read to overwrite them', async () => {
    const state = useThreadGoalState(ref('a'), ref(false))
    const old = deferred<ThreadGoal | null>()
    api.getThreadGoal.mockReturnValueOnce(old.promise)
    const loading = state.refresh()
    state.applyNotification({ method: 'thread/goal/updated', params: { threadId: 'a', goal: { ...goal('a'), tokensUsed: 42, status: 'active' } }, atIso: '' })
    old.resolve(goal('a'))
    await loading
    expect(state.goal.value?.tokensUsed).toBe(42)
    state.applyNotification({ method: 'thread/goal/updated', params: { threadId: 'b', goal: goal('b') }, atIso: '' })
    expect(state.goal.value?.threadId).toBe('a')
    state.applyNotification({ method: 'thread/goal/cleared', params: { threadId: 'a' }, atIso: '' })
    expect(state.goal.value).toBeNull()
  })

  it('coalesces reads and polls only a visible stale active goal', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const state = useThreadGoalState(ref('a'), ref(false))
    api.getThreadGoal.mockResolvedValue({ ...goal('a'), status: 'active' })
    await Promise.all([state.refresh(), state.refresh()])
    expect(api.getThreadGoal).toHaveBeenCalledTimes(1)
    state.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.getThreadGoal).toHaveBeenCalledTimes(2)
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.getThreadGoal).toHaveBeenCalledTimes(2)
    state.stop()
  })
})
