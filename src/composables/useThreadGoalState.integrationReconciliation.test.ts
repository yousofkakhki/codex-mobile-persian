import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
const api = vi.hoisted(() => ({ getThreadGoal: vi.fn(), setThreadGoal: vi.fn(), resumeThreadGoal: vi.fn(), clearThreadGoal: vi.fn() }))
vi.mock('../api/codexGateway', () => ({ ...api, normalizeThreadGoal: (value: unknown) => value, subscribeCodexNotifications: vi.fn(() => vi.fn()) }))
import { useThreadGoalState } from './useThreadGoalState'
const goal = { threadId: 'reconcile', objective: 'Fixture objective', status: 'active' as const, tokenBudget: 500, tokensUsed: 10, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 }
afterEach(() => vi.resetAllMocks())
it('releases a completed stale read after a live update so subsequent polling can read again', async () => {
  const state = useThreadGoalState(ref('reconcile'), ref(false))
  let finish!: (value: typeof goal) => void
  api.getThreadGoal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const reading = state.refresh()
  state.applyNotification({ method: 'thread/goal/updated', params: { threadId: 'reconcile', goal: { ...goal, tokensUsed: 20 } }, atIso: '' })
  finish(goal)
  await reading
  api.getThreadGoal.mockResolvedValueOnce({ ...goal, tokensUsed: 30 })
  await state.refresh()
  expect(api.getThreadGoal).toHaveBeenCalledTimes(2)
  expect(state.goal.value?.tokensUsed).toBe(30)
})
it('releases saving after an intervening live update without replacing newer usage or authorizing another write', async () => {
  const state = useThreadGoalState(ref('reconcile'), ref(false))
  api.getThreadGoal.mockResolvedValueOnce(goal)
  await state.refresh()
  let finish!: (value: typeof goal) => void
  api.setThreadGoal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const writing = state.save({ status: 'paused' })
  state.applyNotification({ method: 'thread/goal/updated', params: { threadId: 'reconcile', goal: { ...goal, tokensUsed: 20 } }, atIso: '' })
  finish(goal)
  await writing
  expect(state.saving.value).toBe(false)
  expect(state.goal.value?.tokensUsed).toBe(20)
  expect(api.setThreadGoal).toHaveBeenCalledTimes(1)
})
