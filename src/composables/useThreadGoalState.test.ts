import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ThreadGoal } from '../api/codexGateway'

const api = vi.hoisted(() => ({ getThreadGoal: vi.fn(), setThreadGoal: vi.fn(), resumeThreadGoal: vi.fn(), clearThreadGoal: vi.fn() }))
vi.mock('../api/codexGateway', () => api)
afterEach(() => vi.resetAllMocks())
const goal = (threadId: string, overrides: Partial<ThreadGoal> = {}): ThreadGoal => ({ threadId, objective: `Goal for ${threadId}`,
  status: 'paused', tokenBudget: 200, tokensUsed: 100, timeUsedSeconds: 15, createdAt: 1, updatedAt: 2, ...overrides })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
async function setup() {
  // Dynamic import lets the pre-implementation RED prove the missing seam with an assertion.
  const files = import.meta.glob('./useThreadGoalState.ts')
  expect(Object.keys(files)).toContain('./useThreadGoalState.ts')
  const { useThreadGoalState } = await files['./useThreadGoalState.ts']!() as typeof import('./useThreadGoalState')
  const selected = ref('a'), home = ref(false)
  return { selected, home, state: useThreadGoalState(selected, home) }
}
describe('per-thread Goal reconciliation', () => {
  it('propagates explicit owner confirmation on recovery', async () => {
    const { state } = await setup()
    api.resumeThreadGoal.mockResolvedValueOnce(goal('a', { status: 'active', tokenBudget: 300 }))
    await (state.resume as any)(300, true)
    expect(api.resumeThreadGoal).toHaveBeenCalledWith('a', 300, true)
  })

  it('isolates loaded/loading/error state immediately and caches an empty successful read separately from not loaded', async () => {
    const { state, selected, home } = await setup()
    api.getThreadGoal.mockResolvedValueOnce(goal('a'))
    await state.refresh()
    expect(state.loaded.value).toBe(true)
    selected.value = 'b'
    expect(state.goal.value).toBeNull()
    expect(state.loaded.value).toBe(false)
    expect(state.loading.value).toBe(false)
    expect(state.error.value).toBe('')
    const pending = deferred<ThreadGoal | null>()
    api.getThreadGoal.mockReturnValueOnce(pending.promise)
    const loading = state.refresh()
    expect(state.loading.value).toBe(true)
    selected.value = 'a'
    expect(state.goal.value?.threadId).toBe('a')
    expect(state.loading.value).toBe(false)
    selected.value = 'b'
    pending.resolve(null)
    await loading
    expect(state.loaded.value).toBe(true)
    expect(state.loading.value).toBe(false)
    home.value = true
    expect(state.goal.value).toBeNull()
    expect(state.loaded.value).toBe(false)
  })
  it('keeps late reads and failures in the captured thread cache, never the visible thread', async () => {
    const { state, selected } = await setup()
    const old = deferred<ThreadGoal | null>()
    api.getThreadGoal.mockReturnValueOnce(old.promise)
    const reading = state.refresh()
    selected.value = 'b'
    api.getThreadGoal.mockRejectedValueOnce(new Error('b read failed'))
    await state.refresh()
    expect(state.error.value).toBe('b read failed')
    old.resolve(goal('a'))
    await reading
    expect(state.goal.value).toBeNull()
    expect(state.error.value).toBe('b read failed')
    selected.value = 'a'
    expect(state.goal.value?.threadId).toBe('a')
    expect(state.error.value).toBe('')
  })
  it.each(['save', 'resume', 'clear'] as const)('stores a late successful %s against the captured thread without blocking another thread', async operation => {
    const { state, selected } = await setup()
    api.getThreadGoal.mockResolvedValueOnce(goal('a', { status: 'budgetLimited' }))
    await state.refresh()
    const late = deferred<ThreadGoal | boolean>()
    if (operation === 'save') api.setThreadGoal.mockReturnValueOnce(late.promise)
    if (operation === 'resume') api.resumeThreadGoal.mockReturnValueOnce(late.promise)
    if (operation === 'clear') api.clearThreadGoal.mockReturnValueOnce(late.promise)
    const writing = operation === 'save' ? state.save({ objective: 'Edited' }) : operation === 'resume' ? state.resume(300) : state.clear()
    expect(state.saving.value).toBe(true)
    selected.value = 'b'
    expect(state.saving.value).toBe(false)
    api.getThreadGoal.mockResolvedValueOnce(goal('b'))
    await state.refresh()
    api.setThreadGoal.mockResolvedValueOnce(goal('b', { objective: 'B changed' }))
    expect(await state.save({ objective: 'B changed' })).toBe(true)
    late.resolve(operation === 'clear' ? true : goal('a', { objective: 'A changed', status: 'active', tokenBudget: 300 }))
    expect(await writing).toBe(false)
    expect(state.goal.value?.objective).toBe('B changed')
    selected.value = 'a'
    expect(state.loaded.value).toBe(true)
    expect(state.goal.value?.objective ?? null).toBe(operation === 'clear' ? null : 'A changed')
    if (operation === 'resume') expect(api.resumeThreadGoal).toHaveBeenCalledWith('a', 300, false)
    if (operation === 'save') expect(api.setThreadGoal.mock.calls[0]).toEqual(['a', { objective: 'Edited' }])
  })
  it.each([
    { status: 'budgetLimited' as const, tokenBudget: 100 },
    { status: 'paused' as const, tokenBudget: 100 },
    { status: 'paused' as const, tokenBudget: null },
  ])('refuses a generic active save that would bypass explicit numeric recovery %j', async overrides => {
    const { state } = await setup()
    api.getThreadGoal.mockResolvedValueOnce(goal('a', overrides))
    await state.refresh()
    expect(await state.save({ status: 'active' })).toBe(false)
    expect(api.setThreadGoal).not.toHaveBeenCalled()
    expect(state.error.value).toMatch(/budget/i)
  })
  it('preserves the existing owner-authorized numeric adjustment path for an exhausted paused Goal', async () => {
    const { state } = await setup()
    api.getThreadGoal.mockResolvedValueOnce(goal('a', { status: 'paused', tokenBudget: 100 }))
    await state.refresh()
    api.setThreadGoal.mockResolvedValueOnce(goal('a', { status: 'active', tokenBudget: 300 }))
    expect(await state.save({ status: 'active', tokenBudget: 300 })).toBe(true)
    expect(api.setThreadGoal).toHaveBeenCalledWith('a', { status: 'active', tokenBudget: 300 })
  })
  it('coalesces duplicate reads and prevents a pre-write read from overwriting a successful update', async () => {
    const { state } = await setup()
    const old = deferred<ThreadGoal | null>()
    api.getThreadGoal.mockReturnValueOnce(old.promise)
    const first = state.refresh(), duplicate = state.refresh()
    expect(api.getThreadGoal).toHaveBeenCalledTimes(1)
    api.setThreadGoal.mockResolvedValueOnce(goal('a', { objective: 'Updated' }))
    await state.save({ objective: 'Updated' })
    old.resolve(goal('a'))
    await Promise.all([first, duplicate])
    expect(state.goal.value?.objective).toBe('Updated')
    expect(state.loading.value).toBe(false)
  })
  it('rejects wrong-thread responses without setting loaded or leaking another objective', async () => {
    const { state } = await setup()
    api.getThreadGoal.mockResolvedValueOnce(goal('b'))
    await state.refresh()
    expect(state.loaded.value).toBe(false)
    expect(state.goal.value).toBeNull()
    expect(state.error.value).toMatch(/different thread/)
  })
})
