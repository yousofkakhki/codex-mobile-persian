<template>
  <section class="thread-activity" aria-label="Thread activity">
    <div class="activity-coverage">
      <span v-if="coverage?.recordingSince">Recording since {{ new Date(coverage.recordingSince).toLocaleString() }}</span>
      <span v-if="coverage?.recoveredHistory">Recovered entries may have missing timestamps or events.</span>
      <span v-if="coverage?.warning" class="activity-warning" role="status">{{ coverage.warning }}</span>
      <span v-if="error" class="activity-warning" role="alert">{{ error }}</span>
      <div class="activity-actions">
        <button v-if="hasOlder" type="button" :disabled="loading" @click="loadEarlier">Load earlier activity</button>
        <button v-if="coverage && !coverage.recoveryComplete" type="button" :disabled="loading" @click="loadRecovered">Recover older history</button>
        <button v-if="error" type="button" :disabled="loading" @click="refresh">Retry</button>
        <button v-if="!following" type="button" @click="jumpToLatest">Follow live activity</button>
        <span v-if="loading" role="status">Loading activity…</span>
      </div>
    </div>
    <div ref="viewport" class="activity-viewport" @scroll="onScroll">
      <p v-if="!entries.length && !loading" class="activity-empty">No activity recorded yet.</p>
      <div :style="{ height: `${offsets[start]}px` }" aria-hidden="true" />
      <ol class="activity-list" aria-label="Activity timeline">
        <li v-for="(entry, index) in visibleEntries" :key="entry.id" :ref="element => observeRow(entry.id, element as Element | null)" class="activity-entry" :data-entry-id="entry.id" :data-status="entry.status">
          <div v-if="entry.turnId && entry.turnId !== entries[start + index - 1]?.turnId" class="activity-turn-label" :title="entry.turnId">Turn {{ entry.turnId.slice(0, 8) }}</div>
          <button class="activity-entry-trigger" type="button" :aria-expanded="expanded === entry.id" :disabled="!entry.hasDetail" @click="toggle(entry)">
            <span class="activity-entry-state" :title="`Status recorded ${new Date(entry.updatedAt).toLocaleString()}`">{{ entry.status }}</span>
            <span class="activity-entry-title">{{ entry.title }}</span>
            <time class="activity-entry-time">{{ entry.startedAt ? new Date(entry.startedAt).toLocaleTimeString() : 'Time unavailable' }}</time>
          </button>
          <p v-if="entry.summary" class="activity-entry-summary">{{ entry.summary }}</p>
          <span v-if="entry.reconstructed" class="activity-provenance">Reconstructed</span>
          <span v-if="entry.durationMs !== null" class="activity-duration">{{ formatActivityDuration(entry.durationMs / 1000) }}</span>
          <span v-else-if="entry.status === 'running' && entry.startedAt" class="activity-duration">{{ formatActivityDuration((now - Date.parse(entry.startedAt)) / 1000) }} elapsed</span>
          <div v-if="expanded === entry.id" class="activity-entry-detail">
            <pre>{{ detailText || (detailLoading ? 'Loading details…' : 'No additional output') }}</pre>
            <span v-if="detailError" class="activity-warning">{{ detailError }}</span>
            <button v-if="detailCursor" type="button" :disabled="detailLoading" @click="readDetail(entry, true)">Load more output</button>
            <button type="button" :disabled="detailLoading" @click="readDetail(entry)">Refresh output</button>
          </div>
        </li>
      </ol>
      <div :style="{ height: `${offsets[offsets.length - 1] - offsets[end]}px` }" aria-hidden="true" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ActivityCoverage, ActivityEntry } from '../../types/activity'
import { getThreadActivityDetail } from '../../api/threadActivity'
import { formatActivityDuration } from '../../utils/activityFormatting'

const props = defineProps<{ threadId: string; entries: ActivityEntry[]; coverage: ActivityCoverage | null; loading: boolean; error: string; hasOlder: boolean; older: () => Promise<void>; recover: () => Promise<void>; refresh: () => Promise<void> }>()
const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(600)
const rowHeights = ref<Record<string, number>>({})
const following = ref(true)
const expanded = ref('')
const detailText = ref('')
const detailCursor = ref<string | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const now = ref(Date.now())
let generation = 0
let observer: ResizeObserver | null = null
const observedRows = new Map<string, Element>()
let detailTimer: ReturnType<typeof setTimeout> | null = null
let elapsedTimer: ReturnType<typeof setInterval> | null = null
const offsets = computed(() => {
  const values = [0]
  for (const entry of props.entries) values.push(values.at(-1)! + (rowHeights.value[entry.id] ?? 110))
  return values
})
function findOffset(target: number): number {
  let lower = 0
  let upper = props.entries.length
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (offsets.value[middle + 1] < target) lower = middle + 1
    else upper = middle
  }
  return lower
}
const start = computed(() => findOffset(Math.max(0, scrollTop.value - 400)))
const end = computed(() => Math.min(props.entries.length, findOffset(scrollTop.value + viewportHeight.value + 400) + 1))
const visibleEntries = computed(() => props.entries.slice(start.value, end.value))
function onScroll(): void {
  if (!viewport.value) return
  scrollTop.value = viewport.value.scrollTop
  viewportHeight.value = viewport.value.clientHeight
  following.value = viewport.value.scrollHeight - viewport.value.scrollTop - viewport.value.clientHeight < 80
}
async function jumpToLatest(): Promise<void> {
  following.value = true
  await nextTick()
  if (viewport.value) { viewport.value.scrollTop = viewport.value.scrollHeight; onScroll() }
}
function observeRow(id: string, element: Element | null): void {
  const previous = observedRows.get(id)
  if (previous && previous !== element) { observer?.unobserve(previous); observedRows.delete(id) }
  if (element) { observedRows.set(id, element); observer?.observe(element) }
}
async function loadEarlier(): Promise<void> {
  following.value = false
  const height = offsets.value.at(-1)!
  const position = viewport.value?.scrollTop ?? 0
  await props.older()
  await nextTick()
  if (viewport.value) { viewport.value.scrollTop = position + Math.max(0, offsets.value.at(-1)! - height); onScroll() }
}
async function loadRecovered(): Promise<void> { following.value = false; await props.recover() }
async function readDetail(entry: ActivityEntry, more = false): Promise<void> {
  if (detailLoading.value) return
  const version = generation
  const id = props.threadId
  detailLoading.value = true
  detailError.value = ''
  try {
    const result = await getThreadActivityDetail(id, entry.id, more ? detailCursor.value ?? undefined : undefined)
    if (version !== generation || expanded.value !== entry.id || id !== props.threadId) return
    detailText.value = more ? detailText.value + result.text : result.text
    detailCursor.value = result.nextCursor
  } catch (failure) {
    if (version === generation) detailError.value = failure instanceof Error ? failure.message : 'Failed to load details'
  } finally { if (version === generation) detailLoading.value = false }
}
function toggle(entry: ActivityEntry): void {
  generation++
  detailLoading.value = false
  detailText.value = ''
  detailCursor.value = null
  detailError.value = ''
  expanded.value = expanded.value === entry.id ? '' : entry.id
  if (expanded.value) void readDetail(entry)
}
watch(() => props.threadId, () => {
  generation++
  expanded.value = ''
  detailText.value = ''
  detailLoading.value = false
  rowHeights.value = {}
  following.value = true
  scrollTop.value = 0
})
watch(() => props.entries, async () => {
  if (following.value) await jumpToLatest()
  const entry = props.entries.find(value => value.id === expanded.value)
  if (entry && !detailTimer && detailText.value.length < 65536) {
    detailTimer = setTimeout(() => { detailTimer = null; if (expanded.value === entry.id) void readDetail(entry) }, 1000)
  }
})
onMounted(() => {
  elapsedTimer = setInterval(() => { if (document.visibilityState === 'visible') now.value = Date.now() }, 1000)
  observer = new ResizeObserver(values => {
    let changed = false
    const heights = { ...rowHeights.value }
    for (const value of values) {
      const id = (value.target as HTMLElement).dataset.entryId
      if (!id) continue
      const height = value.target.getBoundingClientRect().height
      if (heights[id] !== height) { heights[id] = height; changed = true }
    }
    if (changed) rowHeights.value = heights
    if (following.value) void jumpToLatest()
  })
  viewportHeight.value = viewport.value?.clientHeight || 600
  for (const element of observedRows.values()) observer.observe(element)
  void jumpToLatest()
})
onBeforeUnmount(() => { generation++; observer?.disconnect(); if (detailTimer) clearTimeout(detailTimer); if (elapsedTimer) clearInterval(elapsedTimer) })
</script>
