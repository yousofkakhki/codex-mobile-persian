import { computed, ref, watch, type Ref } from 'vue'
import { getThreadActivity } from '../api/threadActivity'
import { subscribeCodexNotifications, type RpcNotification } from '../api/codexGateway'
import type { ActivityCoverage, ActivityEntry, ActivityPage } from '../types/activity'

const TAB_STORAGE = 'codex-web-local.thread-view-tab.v1'
const CATCHUP_PAGES = 4
const CATCHUP_ENTRIES = 200
const CATCHUP_WORK_MS = 1000
const RETAINED_ENTRIES = 1000
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
  const catchupPaused = ref(false)
  let resumeCursor = '0'
  let generation = 0
  let loaded = false
  let recentWindowStale = false
  let request: { generation: number; promise: Promise<void> } | null = null
  let stopNotifications: (() => void) | null = null

  function selected(id: string, version: number): boolean { return id === threadId.value && version === generation && !isHome.value && view.value === 'activity' }
  function retain(incoming: ActivityEntry[], older = false): boolean {
    const merged = mergeActivityEntries(entries.value, incoming)
    const trimmed = merged.length > RETAINED_ENTRIES
    entries.value = older ? merged.slice(0, RETAINED_ENTRIES) : merged.slice(-RETAINED_ENTRIES)
    if (trimmed && older) recentWindowStale = true
    if (trimmed && !older) nextCursor.value = String(Math.min(...entries.value.map(entry => entry.sequence)))
    return trimmed
  }
  function applyPage(page: ActivityPage, older = false): void {
    const trimmed = retain(page.entries, older)
    coverage.value = page.coverage
    if (trimmed && !coverage.value.warning) coverage.value = { ...coverage.value, warning: 'Activity keeps a bounded 1,000-entry window. Use earlier or recent updates to move the window.' }
  }

  function fetchPage(mode: 'initial' | 'older' | 'catchup' | 'recover' = 'initial', automatic = false): Promise<void> {
    if (request?.generation === generation) return request.promise
    const id = threadId.value
    if (!id || isHome.value || view.value !== 'activity' || automatic && catchupPaused.value) return Promise.resolve()
    const reloadRecent = mode === 'catchup' && recentWindowStale
    if (reloadRecent) mode = 'initial'
    const version = generation
    loading.value = true
    error.value = ''
    const started = performance.now()
    const promise = (async () => {
      try {
        const page = await getThreadActivity(id, mode === 'older' ? { cursor: nextCursor.value ?? undefined } : mode === 'catchup' ? { since: resumeCursor } : mode === 'recover' ? { recover: true } : {})
        if (!selected(id, version)) return
        if (page.entries.length > 100) throw new Error('Activity page exceeds its entry limit; retry explicitly.')
        if (reloadRecent) { entries.value = []; recentWindowStale = false; catchupPaused.value = false }
        applyPage(page, mode === 'older' || mode === 'recover')
        if (mode === 'older') nextCursor.value = page.nextCursor
        else if (mode === 'catchup') {
          let pages = 1
          let count = page.entries.length
          const previousCursor = Number(resumeCursor)
          if (page.nextCursor && (!Number.isSafeInteger(Number(page.resumeCursor)) || Number(page.resumeCursor) <= previousCursor)) throw new Error('Activity cursor did not advance; retry explicitly.')
          resumeCursor = page.resumeCursor
          let following = page
          while (following.nextCursor && selected(id, version) && pages < CATCHUP_PAGES && count <= CATCHUP_ENTRIES - 100 && performance.now() - started < CATCHUP_WORK_MS) {
            following = await getThreadActivity(id, { since: resumeCursor })
            if (!selected(id, version)) return
            if (following.entries.length > 100) throw new Error('Activity page exceeds its entry limit; retry explicitly.')
            if (following.nextCursor && (!Number.isSafeInteger(Number(following.resumeCursor)) || Number(following.resumeCursor) <= Number(resumeCursor))) throw new Error('Activity cursor did not advance; retry explicitly.')
            applyPage(following)
            resumeCursor = following.resumeCursor
            pages++
            count += following.entries.length
          }
          catchupPaused.value = Boolean(following.nextCursor)
          if (catchupPaused.value) error.value = 'Recent Activity catchup paused at its work limit. Load recent updates to continue.'
        } else {
          nextCursor.value = page.nextCursor
          resumeCursor = page.resumeCursor
        }
        loaded = true
      } catch (failure) {
        if (selected(id, version)) { catchupPaused.value = mode === 'catchup'; error.value = failure instanceof Error ? failure.message : 'Failed to load activity' }
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
    catchupPaused.value = false
    resumeCursor = '0'
    loaded = false
    recentWindowStale = false
  }, { flush: 'sync' })
  watch(view, () => { generation++; loading.value = false }, { flush: 'sync' })
  watch([threadId, isHome, view], () => {
    if (view.value === 'activity' && threadId.value && !isHome.value) void fetchPage(loaded ? 'catchup' : 'initial', true)
  }, { immediate: true })

  function setView(value: 'chat' | 'activity'): void {
    if (!threadId.value || isHome.value) return
    tabs.value = { ...tabs.value, [threadId.value]: value }
    try { window.localStorage.setItem(TAB_STORAGE, JSON.stringify(tabs.value)) } catch {}
    // Same-tick hide/reopen can coalesce the async watcher back to its original
    // value; launch against the newly invalidated generation, not the old request.
    if (value === 'activity') void fetchPage(loaded ? 'catchup' : 'initial', true)
  }

  function applyNotification(notification: RpcNotification): void {
    if (notification.method === 'ready') {
      if (view.value === 'activity' && loaded) void fetchPage('catchup', true)
      return
    }
    if (notification.method !== 'activity/updated') return
    const params = notification.params as { threadId: string; entry?: ActivityEntry; coverage?: ActivityCoverage } | null
    if (!params || params.threadId !== threadId.value || isHome.value || view.value !== 'activity') return
    if (params.coverage) coverage.value = params.coverage
    if (params.entry?.threadId === threadId.value && retain([params.entry]) && coverage.value && !coverage.value.warning) coverage.value = { ...coverage.value, warning: 'Activity keeps a bounded 1,000-entry window. Use earlier or recent updates to move the window.' }
  }

  function start(): void { if (!stopNotifications) stopNotifications = subscribeCodexNotifications(applyNotification) }
  function stop(): void { stopNotifications?.(); stopNotifications = null; generation++; loading.value = false }
  return { view, setView, entries, coverage, loading, error, nextCursor, catchupPaused, start, stop, applyNotification, refresh: () => fetchPage(loaded ? 'catchup' : 'initial'), older: () => fetchPage('older'), recover: () => fetchPage('recover') }
}
