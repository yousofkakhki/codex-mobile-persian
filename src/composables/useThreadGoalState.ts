import { computed, reactive, ref, watch, type Ref } from 'vue'
import { clearThreadGoal, getThreadGoal, resumeThreadGoal, setThreadGoal, normalizeThreadGoal, subscribeCodexNotifications, type RpcNotification, type ThreadGoal, type ThreadGoalSetInput } from '../api/codexGateway'

type GoalEntry = { goal: ThreadGoal | null; loaded: boolean; loading: boolean; saving: boolean; error: string; syncedAt: number }

export function useThreadGoalState(selectedThreadId: Ref<string>, isHomeRoute: Readonly<Ref<boolean>>) {
  const entries = reactive(new Map<string, GoalEntry>())
  const versions = new Map<string, number>()
  const reads = new Map<string, Promise<void>>()
  const now = ref(Date.now())
  let stopNotifications: (() => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let selectionVersion = 0
  watch([selectedThreadId, isHomeRoute], () => { selectionVersion++ }, { flush: 'sync' })
  const activeId = computed(() => isHomeRoute.value ? '' : selectedThreadId.value.trim())
  function entryFor(threadId: string): GoalEntry {
    if (!entries.has(threadId)) entries.set(threadId, { goal: null, loaded: false, loading: false, saving: false, error: '', syncedAt: 0 })
    return entries.get(threadId)!
  }
  const selectedEntry = computed(() => activeId.value ? entries.get(activeId.value) : undefined)
  const goal = computed(() => selectedEntry.value?.goal ?? null)
  const syncedAt = computed(() => selectedEntry.value?.syncedAt ?? 0)
  const elapsedSeconds = computed(() => {
    const value = goal.value
    if (!value) return 0
    const end = value.status === 'complete' ? value.updatedAt * 1000 : now.value
    return Math.max(0, Math.floor((end - value.createdAt * 1000) / 1000))
  })
  const loaded = computed(() => selectedEntry.value?.loaded ?? false)
  const loading = computed(() => selectedEntry.value?.loading ?? false)
  const saving = computed(() => selectedEntry.value?.saving ?? false)
  const error = computed({ get: () => selectedEntry.value?.error ?? '', set: (value: string) => {
    if (activeId.value) entryFor(activeId.value).error = value
  } })
  const nextVersion = (threadId: string) => {
    const version = (versions.get(threadId) ?? 0) + 1
    versions.set(threadId, version)
    return version
  }
  const validate = (result: ThreadGoal | null, threadId: string) => {
    if (result && result.threadId !== threadId) throw new Error('Goal response belongs to a different thread')
  }

  async function refresh(): Promise<void> {
    const threadId = activeId.value
    if (!threadId) return
    const pending = reads.get(threadId)
    if (pending) return pending
    const entry = entryFor(threadId)
    if (entry.saving) return
    const version = nextVersion(threadId)
    entry.loading = true
    entry.error = ''
    const reading = (async () => {
      try {
        const result = await getThreadGoal(threadId)
        validate(result, threadId)
        if (versions.get(threadId) !== version) return
        entry.goal = result
        entry.loaded = true
      entry.syncedAt = Date.now()
        entry.syncedAt = Date.now()
      } catch (failure) {
        if (versions.get(threadId) === version) entry.error = failure instanceof Error ? failure.message : 'Failed to load goal'
      } finally {
        if (versions.get(threadId) === version) {
          entry.loading = false
          reads.delete(threadId)
        }
      }
    })()
    reads.set(threadId, reading)
    return reading
  }

  function applyNotification(notification: RpcNotification): void {
    if (notification.method === 'ready') {
      if (Date.now() - syncedAt.value >= 2000) void refresh()
      return
    }
    const params = notification.params as { threadId?: string; goal?: unknown } | null
    if (!params || !activeId.value || params.threadId !== activeId.value) return
    if (!['thread/goal/updated', 'thread/goal/cleared'].includes(notification.method)) return
    const value = notification.method === 'thread/goal/cleared' ? null : normalizeThreadGoal(params.goal)
    if (notification.method === 'thread/goal/updated' && (!value || value.threadId !== params.threadId)) return
    nextVersion(params.threadId)
    const entry = entryFor(params.threadId)
    entry.goal = value
    entry.loaded = true
    entry.loading = false
    entry.error = ''
    entry.syncedAt = Date.now()
  }

  async function write(operation: (threadId: string) => Promise<ThreadGoal | null>): Promise<boolean> {
    const threadId = activeId.value
    if (!threadId) return false
    const entry = entryFor(threadId)
    if (entry.saving) return false
    const version = nextVersion(threadId), selection = selectionVersion
    reads.delete(threadId)
    entry.loading = false
    entry.saving = true
    entry.error = ''
    try {
      const result = await operation(threadId)
      validate(result, threadId)
      if (versions.get(threadId) !== version) return false
      // A late successful write still updates its captured thread, even if that thread is not visible.
      entry.goal = result
      entry.loaded = true
      entry.syncedAt = Date.now()
      return activeId.value === threadId && selectionVersion === selection
    } catch (failure) {
      if (versions.get(threadId) === version) entry.error = failure instanceof Error ? failure.message : 'Failed to update goal'
      return false
    } finally {
      if (versions.get(threadId) === version) entry.saving = false
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
    goal, loaded, loading, saving, error, syncedAt, elapsedSeconds, refresh, applyNotification, start, stop,
    save: (input: ThreadGoalSetInput) => {
      const captured = { ...input }
      const existing = goal.value
      const explicitAdjustment = existing && Number.isSafeInteger(captured.tokenBudget)
        && typeof captured.tokenBudget === 'number' && captured.tokenBudget > existing.tokensUsed
        && captured.tokenBudget !== existing.tokenBudget
      if (captured.status === 'active' && existing
        && (existing.status === 'budgetLimited'
          || (!explicitAdjustment && ((existing.tokenBudget !== null && existing.tokenBudget <= existing.tokensUsed)
            || (existing.status !== 'active' && existing.tokenBudget === null))))) {
        error.value = 'An owner-approved numeric budget adjustment is required; use explicit Goal recovery.'
        return Promise.resolve(false)
      }
      return write(threadId => setThreadGoal(threadId, captured))
    },
    resume: (tokenBudget: number, ownerConfirmed = false) => write(threadId => resumeThreadGoal(threadId, tokenBudget, ownerConfirmed)),
    clear: () => write(async threadId => {
      if (!await clearThreadGoal(threadId)) throw new Error('Goal was not cleared')
      return null
    }),
  }
}
