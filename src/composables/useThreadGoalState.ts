import { computed, ref, watch, type Ref } from 'vue'
import { getThreadGoal, setThreadGoal, resumeThreadGoal, clearThreadGoal, normalizeThreadGoal, subscribeCodexNotifications, type ThreadGoal, type ThreadGoalSetInput, type RpcNotification } from '../api/codexGateway'

export function useThreadGoalState(selectedThreadId: Ref<string>, isHomeRoute: Readonly<Ref<boolean>>) {
  const storedGoal = ref<ThreadGoal | null>(null)
  const error = ref('')
  const saving = ref(false)
  const syncedAt = ref(0)
  const now = ref(Date.now())
  let generation = 0
  let revision = 0
  let reading: { threadId: string; generation: number; promise: Promise<void> } | null = null
  let stopNotifications: (() => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  watch([selectedThreadId, isHomeRoute], () => {
    generation++
    revision++
    storedGoal.value = null
    syncedAt.value = 0
    error.value = ''
  }, { flush: 'sync' })
  const goal = computed(() => !isHomeRoute.value && storedGoal.value?.threadId === selectedThreadId.value.trim()
    ? storedGoal.value : null)
  const elapsedSeconds = computed(() => {
    const value = goal.value
    if (!value) return 0
    const end = value.status === 'complete' ? value.updatedAt * 1000 : now.value
    return Math.max(0, Math.floor((end - value.createdAt * 1000) / 1000))
  })
  const current = (threadId: string, request: number) => request === generation
    && selectedThreadId.value.trim() === threadId && !isHomeRoute.value
  function validate(value: ThreadGoal | null, threadId: string): void {
    if (value && value.threadId !== threadId) throw new Error('Goal response belongs to a different thread')
  }

  function refresh(): Promise<void> {
    const threadId = selectedThreadId.value.trim()
    if (!threadId || isHomeRoute.value) return Promise.resolve()
    if (reading?.threadId === threadId && reading.generation === generation) return reading.promise
    const request = generation
    const version = revision
    const promise = (async () => {
      try {
        const result = await getThreadGoal(threadId)
        validate(result, threadId)
        if (current(threadId, request) && version === revision) {
          storedGoal.value = result
          syncedAt.value = Date.now()
          error.value = ''
        }
      } catch (failure) {
        if (current(threadId, request) && version === revision) error.value = failure instanceof Error ? failure.message : 'Failed to load goal'
      }
    })()
    reading = { threadId, generation: request, promise }
    void promise.finally(() => { if (reading?.promise === promise) reading = null })
    return promise
  }

  function applyNotification(notification: RpcNotification): void {
    if (notification.method === 'ready') {
      if (Date.now() - syncedAt.value >= 2000) void refresh()
      return
    }
    const params = notification.params as { threadId?: string; goal?: unknown } | null
    if (!params || params.threadId !== selectedThreadId.value.trim() || isHomeRoute.value) return
    if (notification.method === 'thread/goal/cleared') {
      revision++
      storedGoal.value = null
      syncedAt.value = Date.now()
      error.value = ''
    } else if (notification.method === 'thread/goal/updated') {
      const value = normalizeThreadGoal(params.goal)
      if (!value || value.threadId !== params.threadId) return
      revision++
      storedGoal.value = value
      syncedAt.value = Date.now()
      error.value = ''
    }
  }

  async function write(operation: (threadId: string) => Promise<ThreadGoal | null>): Promise<boolean> {
    const threadId = selectedThreadId.value.trim()
    if (!threadId || isHomeRoute.value || saving.value) return false
    const request = ++generation
    const version = ++revision
    saving.value = true
    error.value = ''
    try {
      const result = await operation(threadId)
      validate(result, threadId)
      if (!current(threadId, request)) return false
      if (version === revision) storedGoal.value = result
      syncedAt.value = Date.now()
      return true
    } catch (failure) {
      if (current(threadId, request)) error.value = failure instanceof Error ? failure.message : 'Failed to update goal'
      return false
    } finally {
      saving.value = false
    }
  }

  function start(): void {
    if (stopNotifications || typeof window === 'undefined') return
    stopNotifications = subscribeCodexNotifications(applyNotification)
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      now.value = Date.now()
      if (goal.value?.status === 'active' && !saving.value && Date.now() - syncedAt.value >= 5000) void refresh()
    }, 1000)
  }

  function stop(): void {
    stopNotifications?.()
    stopNotifications = null
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  return {
    goal, error, saving, syncedAt, elapsedSeconds, refresh, applyNotification, start, stop,
    save: (input: ThreadGoalSetInput) => write(threadId => setThreadGoal(threadId, input)),
    resume: () => write(resumeThreadGoal),
    clear: () => write(async threadId => {
      if (!await clearThreadGoal(threadId)) throw new Error('Goal was not cleared')
      return null
    }),
  }
}
