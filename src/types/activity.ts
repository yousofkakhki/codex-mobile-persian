export type ActivityKind = 'prompt' | 'queue' | 'turn' | 'goal' | 'plan' | 'message' | 'command' | 'fileChange' | 'approval' | 'tool' | 'error' | 'interruption'
export type ActivityStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'paused' | 'blocked' | 'cleared'

export type ActivityEntry = {
  id: string
  threadId: string
  turnId: string | null
  itemId: string | null
  goalCreatedAt: number | null
  sequence: number
  order?: number
  kind: ActivityKind
  status: ActivityStatus
  title: string
  summary: string
  startedAt: string | null
  updatedAt: string
  durationMs: number | null
  hasDetail: boolean
  reconstructed: boolean
  historyOrder?: number
}

export type ActivityCoverage = {
  recordingSince: string | null
  recoveredHistory: boolean
  recoveryCursor: string | null
  recoveryComplete: boolean
  warning: string | null
  recoveryPages?: number
}

export type ActivityPage = {
  entries: ActivityEntry[]
  nextCursor: string | null
  resumeCursor: string
  coverage: ActivityCoverage
}

export type ActivityDetail = { text: string; nextCursor: string | null }
export type ActivityInput = Omit<ActivityEntry, 'sequence' | 'updatedAt'> & { updatedAt?: string }
