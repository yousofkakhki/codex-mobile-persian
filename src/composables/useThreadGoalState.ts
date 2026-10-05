import { computed, ref, watch, type Ref } from 'vue'
import { getThreadGoal, setThreadGoal, resumeThreadGoal, clearThreadGoal, type ThreadGoal, type ThreadGoalSetInput } from '../api/codexGateway'

export function useThreadGoalState(selectedThreadId: Ref<string>, isHomeRoute: Readonly<Ref<boolean>>) {
  const storedGoal = ref<ThreadGoal | null>(null)
  const error = ref('')
  const saving = ref(false)
  let generation = 0
  watch([selectedThreadId, isHomeRoute], () => {
    generation++
    storedGoal.value = null
    error.value = ''
  }, { flush: 'sync' })
  const goal = computed(() => !isHomeRoute.value && storedGoal.value?.threadId === selectedThreadId.value.trim()
    ? storedGoal.value : null)
  const current = (threadId: string, request: number) => request === generation
    && selectedThreadId.value.trim() === threadId && !isHomeRoute.value
  function validate(value: ThreadGoal | null, threadId: string): void {
    if (value && value.threadId !== threadId) throw new Error('Goal response belongs to a different thread')
  }

  async function refresh(): Promise<void> {
    const threadId = selectedThreadId.value.trim()
    const request = ++generation
    storedGoal.value = null
    error.value = ''
    if (!threadId || isHomeRoute.value) return
    try {
      const result = await getThreadGoal(threadId)
      validate(result, threadId)
      if (current(threadId, request)) storedGoal.value = result
    } catch (failure) {
      if (current(threadId, request)) error.value = failure instanceof Error ? failure.message : 'Failed to load goal'
    }
  }

  async function write(operation: (threadId: string) => Promise<ThreadGoal | null>): Promise<boolean> {
    const threadId = selectedThreadId.value.trim()
    if (!threadId || isHomeRoute.value || saving.value) return false
    const request = ++generation
    saving.value = true
    error.value = ''
    try {
      const result = await operation(threadId)
      validate(result, threadId)
      if (!current(threadId, request)) return false
      storedGoal.value = result
      return true
    } catch (failure) {
      if (current(threadId, request)) error.value = failure instanceof Error ? failure.message : 'Failed to update goal'
      return false
    } finally {
      saving.value = false
    }
  }

  return {
    goal, error, saving, refresh,
    save: (input: ThreadGoalSetInput) => write(threadId => setThreadGoal(threadId, input)),
    resume: () => write(resumeThreadGoal),
    clear: () => write(async threadId => {
      if (!await clearThreadGoal(threadId)) throw new Error('Goal was not cleared')
      return null
    }),
  }
}
