import { computed, ref, watch, type Ref } from 'vue'
import { getThreadActivity } from '../api/threadActivity'
import { subscribeCodexNotifications, type RpcNotification } from '../api/codexGateway'
import type { ActivityCoverage, ActivityEntry, ActivityPage } from '../types/activity'

const TAB_STORAGE = 'codex-web-local.thread-view-tab.v1'
function loadTabs(): Record<string, 'chat' | 'activity'> {
  const result: Record<string, 'chat' | 'activity'> = Object.create(null)
  if (typeof window === 'undefined') return result
  try {
    const stored = JSON.parse(window.localStorage.getItem(TAB_STORAGE) ?? '{}')
    for (const [id, value] of Object.entries(stored ?? {})) if (value === 'chat' || value === 'activity') result[id] = value
  } catch {}
  return result
}

export function mergeActivityEntries(current: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const entries = new Map(current.map(entry => [entry.id, entry]))
  for (const entry of incoming) {
    const previous = entries.get(entry.id)
    if (!previous || entry.sequence > previous.sequence) entries.set(entry.id, entry)
  }
  return [...entries.values()].sort((first, second) => {
    if (first.reconstructed !== second.reconstructed) return first.reconstructed ? -1 : 1
    if (first.reconstructed) return (first.historyOrder ?? first.sequence) - (second.historyOrder ?? second.sequence)
    return (first.order ?? first.sequence) - (second.order ?? second.sequence)
  })
}

export function useThreadActivity(threadId: Ref<string>, isHome: Readonly<Ref<boolean>>) {
  const tabs = ref(loadTabs())
  const view = computed(() => isHome.value ? 'chat' : tabs.value[threadId.value] ?? 'chat')
  const entries = ref<ActivityEntry[]>([])
  const coverage = ref<ActivityCoverage | null>(null)
  const loading = ref(false)
  const error = ref('')
  const nextCursor = ref<string | null>(null)
  let resumeCursor = '0'
  let generation = 0
  let loaded = false
  let request: { generation: number; promise: Promise<void> } | null = null
  let stopNotifications: (() => void) | null = null

  function selected(id: string, version: number): boolean { return id === threadId.value && version === generation && !isHome.value }
  function applyPage(page: ActivityPage): void {
    entries.value = mergeActivityEntries(entries.value, page.entries)
    coverage.value = page.coverage
  }

  function fetchPage(mode: 'initial' | 'older' | 'catchup' | 'recover' = 'initial'): Promise<void> {
    if (request?.generation === generation) return request.promise
    const id = threadId.value
    if (!id || isHome.value) return Promise.resolve()
    const version = generation
    loading.value = true
    error.value = ''
    const promise = (async () => {
      try {
        const page = await getThreadActivity(id, mode === 'older' ? { cursor: nextCursor.value ?? undefined } : mode === 'catchup' ? { since: resumeCursor } : mode === 'recover' ? { recover: true } : {})
        if (!selected(id, version)) return
        applyPage(page)
        if (mode === 'older') nextCursor.value = page.nextCursor
        else if (mode === 'catchup') {
          resumeCursor = page.resumeCursor
          let following = page
          while (following.nextCursor && selected(id, version)) {
            following = await getThreadActivity(id, { since: resumeCursor })
            if (!selected(id, version)) return
            applyPage(following)
            resumeCursor = following.resumeCursor
          }
        } else {
          nextCursor.value = page.nextCursor
          resumeCursor = page.resumeCursor
        }
        loaded = true
      } catch (failure) {
        if (selected(id, version)) error.value = failure instanceof Error ? failure.message : 'Failed to load activity'
      } finally {
        if (selected(id, version)) loading.value = false
      }
    })()
    request = { generation: version, promise }
    void promise.finally(() => { if (request?.promise === promise) request = null })
    return promise
  }

  watch([threadId, isHome], () => {
    generation++
    entries.value = []
    coverage.value = null
    loading.value = false
    error.value = ''
    nextCursor.value = null
    resumeCursor = '0'
    loaded = false
  }, { flush: 'sync' })
  watch([threadId, isHome, view], () => {
    if (view.value === 'activity' && threadId.value && !isHome.value) void fetchPage(loaded ? 'catchup' : 'initial')
  }, { immediate: true })

  function setView(value: 'chat' | 'activity'): void {
    if (!threadId.value || isHome.value) return
    tabs.value = { ...tabs.value, [threadId.value]: value }
    try { window.localStorage.setItem(TAB_STORAGE, JSON.stringify(tabs.value)) } catch {}
  }

  function applyNotification(notification: RpcNotification): void {
    if (notification.method === 'ready') {
      if (view.value === 'activity' && loaded) void fetchPage('catchup')
      return
    }
    if (notification.method !== 'activity/updated') return
    const params = notification.params as { threadId: string; entry?: ActivityEntry; coverage?: ActivityCoverage } | null
    if (!params || params.threadId !== threadId.value || isHome.value || view.value !== 'activity') return
    if (params.coverage) coverage.value = params.coverage
    if (params.entry?.threadId === threadId.value) entries.value = mergeActivityEntries(entries.value, [params.entry])
  }

  function start(): void { if (!stopNotifications) stopNotifications = subscribeCodexNotifications(applyNotification) }
  function stop(): void { stopNotifications?.(); stopNotifications = null; generation++ }
  return { view, setView, entries, coverage, loading, error, nextCursor, start, stop, applyNotification, refresh: () => fetchPage(loaded ? 'catchup' : 'initial'), older: () => fetchPage('older'), recover: () => fetchPage('recover') }
}
