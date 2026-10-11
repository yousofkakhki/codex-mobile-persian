import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type GoalBudgetAuditRecord = {
  event: 'goal_budget_adjusted'
  atIso: string
  threadId: string
  actor: 'owner'
  source: 'codex-web'
  previousStatus: string
  previousTotalBudget: number | null
  previousTokensUsed: number
  requestedTotalBudget: number
  resultingStatus: string
  resultingTotalBudget: number | null
  resultingTokensUsed: number
}

export type GoalBudgetAdjustment = {
  threadId: string
  tokenBudget: number
  status: 'active'
}

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function parseGoalBudgetAdjustment(value: unknown): GoalBudgetAdjustment | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const threadId = typeof record.threadId === 'string' ? record.threadId.trim() : ''
  const status = record.status
  if (!threadId || status !== 'active' || !isFinitePositiveInteger(record.tokenBudget)) return null
  return { threadId, tokenBudget: record.tokenBudget, status: 'active' }
}

function auditPath(codexHome: string): string {
  return join(codexHome, 'goal-budget-audit.jsonl')
}

export async function appendGoalBudgetAuditRecord(codexHome: string, record: GoalBudgetAuditRecord): Promise<void> {
  await mkdir(codexHome, { recursive: true })
  await appendFile(auditPath(codexHome), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function getLatestGoalBudgetAudit(codexHome: string, threadId: string): Promise<GoalBudgetAuditRecord | null> {
  try {
    const lines = (await readFile(auditPath(codexHome), 'utf8')).split(/\r?\n/u).filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index] ?? '') as GoalBudgetAuditRecord
        if (record.event === 'goal_budget_adjusted' && record.threadId === threadId) return record
      } catch {
        // Ignore a partial final record; append-only records remain readable.
      }
    }
  } catch {
    return null
  }
  return null
}
