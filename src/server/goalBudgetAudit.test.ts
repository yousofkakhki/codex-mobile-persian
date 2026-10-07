import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendGoalBudgetAuditRecord,
  getLatestGoalBudgetAudit,
  parseGoalBudgetAdjustment,
  type GoalBudgetAuditRecord,
} from './goalBudgetAudit'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('goal budget audit records', () => {
  it('recognizes an explicit token budget without requiring an objective', () => {
    expect(parseGoalBudgetAdjustment({
      threadId: 'thread-1',
      tokenBudget: 100_000,
      status: 'active',
    })).toEqual({
      threadId: 'thread-1',
      tokenBudget: 100_000,
      status: 'active',
    })
  })

  it('writes and reads back the latest owner audit record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-goal-budget-audit-'))
    temporaryDirectories.push(directory)
    const record: GoalBudgetAuditRecord = {
      event: 'goal_budget_adjusted',
      atIso: '2026-09-27T12:00:00.000Z',
      threadId: 'thread-1',
      actor: 'owner',
      source: 'codex-web',
      previousStatus: 'budgetLimited',
      previousTotalBudget: 25_000,
      previousTokensUsed: 49_437,
      requestedTotalBudget: 100_000,
      resultingStatus: 'active',
      resultingTotalBudget: 100_000,
      resultingTokensUsed: 49_437,
    }

    await appendGoalBudgetAuditRecord(directory, record)
    await appendGoalBudgetAuditRecord(directory, { ...record, atIso: '2026-09-27T12:01:00.000Z', requestedTotalBudget: 150_000, resultingTotalBudget: 150_000 })

    await expect(getLatestGoalBudgetAudit(directory, 'thread-1')).resolves.toMatchObject({
      atIso: '2026-09-27T12:01:00.000Z',
      requestedTotalBudget: 150_000,
      resultingTotalBudget: 150_000,
    })
    await expect(getLatestGoalBudgetAudit(directory, 'other-thread')).resolves.toBeNull()
    await expect(readFile(join(directory, 'goal-budget-audit.jsonl'), 'utf8')).resolves.toContain('goal_budget_adjusted')
  })
})
