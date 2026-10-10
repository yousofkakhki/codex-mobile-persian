import type { IncomingMessage, ServerResponse } from 'node:http'
import { ActivityRecorder } from './activityRecorder.js'
import { ActivityStore } from './activityStore.js'

export async function handleActivityRoutes(req: IncomingMessage, res: ServerResponse, url: URL, store: ActivityStore, recorder: ActivityRecorder, rpc: { rpc(method: string, params: unknown): Promise<unknown> }): Promise<boolean> {
  if (req.method !== 'GET' || !['/codex-api/thread-activity', '/codex-api/thread-activity-detail'].includes(url.pathname)) return false
  const threadId = url.searchParams.get('threadId')?.trim() ?? ''
  try {
    if (!threadId) throw new Error('Missing threadId')
    let result
    if (url.pathname.endsWith('-detail')) {
      const id = url.searchParams.get('entryId') ?? ''
      if (!id) throw new Error('Missing entryId')
      result = await store.detail(threadId, id, url.searchParams.get('cursor') ?? '0')
    } else {
      const cursor = url.searchParams.get('cursor') ?? undefined
      const since = url.searchParams.get('since') ?? undefined
      if (cursor && since) throw new Error('Use either cursor or since')
      const limit = Number(url.searchParams.get('limit') ?? 50)
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid activity limit')
      if (!cursor && since === undefined) await recorder.recover(threadId, rpc, url.searchParams.get('recover') === 'more')
      await recorder.flush(threadId)
      result = await store.page(threadId, { cursor, since, limit })
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(result))
  } catch (failure) {
    res.statusCode = failure instanceof Error && /^Missing|Invalid|Use either/.test(failure.message) ? 400 : 500
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: res.statusCode === 400 ? (failure as Error).message : 'Activity history is temporarily unavailable' }))
  }
  return true
}
