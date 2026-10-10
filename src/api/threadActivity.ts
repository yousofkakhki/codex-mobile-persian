import type { ActivityDetail, ActivityPage } from '../types/activity'

async function getActivityJson<T>(endpoint: string, params: Record<string, string | undefined>): Promise<T> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value)
  const response = await fetch(endpoint + '?' + query.toString(), { cache: 'no-store' })
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Activity history is unavailable')
  return value as T
}

export function getThreadActivity(threadId: string, options: { cursor?: string; since?: string; recover?: boolean } = {}): Promise<ActivityPage> {
  return getActivityJson('/codex-api/thread-activity', { threadId, cursor: options.cursor, since: options.since, recover: options.recover ? 'more' : undefined })
}

export function getThreadActivityDetail(threadId: string, entryId: string, cursor?: string): Promise<ActivityDetail> {
  return getActivityJson('/codex-api/thread-activity-detail', { threadId, entryId, cursor })
}
