import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGoalPolicyFixture } from './goalPolicyFixture.test-support'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { appendGoalBudgetAuditRecord } from './goalBudgetAudit'
vi.mock('./goalBudgetAudit', async () => ({ ...await vi.importActual('./goalBudgetAudit'), appendGoalBudgetAuditRecord: vi.fn(async () => {}) }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
const existing = { threadId: 'fixture-owned', objective: 'Preserve objective', status: 'budgetLimited', tokenBudget: 50,
  tokensUsed: 50, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 }
async function request(params: Record<string, unknown>, options: { authorized?: boolean; before?: typeof existing | null; after?: Record<string, unknown> } = {}) {
  let stored: Record<string, unknown> | null = options.before === null ? null : { ...existing, ...options.before }
  const rpc = vi.fn(async (method: string, input: any) => {
    if (method === 'thread/goal/get') return { goal: stored }
    if (method === 'thread/goal/set') { stored = { ...(stored ?? { ...existing, tokensUsed: 0, timeUsedSeconds: 0 }), ...input, ...options.after }; return { goal: stored } }
    throw new Error('Unexpected synthetic RPC')
  })
  vi.stubGlobal('__codexRemoteSharedBridge__', { version: 'experimental-api-v2', appServer: await createGoalPolicyFixture(rpc, existing.threadId), terminalManager: {}, methodCatalog: {}, telegramBridge: {}, backendQueueProcessor: {} })
  const authorize = vi.fn(() => options.authorized ?? false)
  const bridge = createCodexBridgeMiddleware({ isOwnerAuthorized: authorize })
  const req = Readable.from([JSON.stringify({ method: 'thread/goal/set', params })]) as any
  req.method = 'POST'; req.url = '/codex-api/rpc'; req.headers = {}
  let output = ''
  const res = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }) as any
  res.setHeader = () => {}
  await bridge(req, res, () => { throw new Error('Unexpected next') })
  return { status: res.statusCode, body: JSON.parse(output), rpc, authorize, writes: rpc.mock.calls.filter(([method]) => method === 'thread/goal/set') }
}
describe('Goal budget payload authorization', () => {
  it('rejects a pre-write Goal from a different thread without dispatch', async () => {
    const result = await request({ threadId: existing.threadId, status: 'active', tokenBudget: 100, ownerConfirmed: true }, { authorized: true, before: { ...existing, threadId: 'foreign' } })
    expect(result.status).toBe(502)
    expect(result.writes).toHaveLength(0)
  })

  it.each([{ tokenBudget: null }, { tokenBudget: 100, objective: existing.objective }, { tokenBudget: 100, status: 'paused' }])('denies every explicit budget shape without owner authorization %j', async shape => {
    const result = await request({ threadId: existing.threadId, ownerConfirmed: true, ...shape })
    expect(result.status).toBe(403)
    expect(result.writes).toHaveLength(0)
  })
  it('audits a confirmed budget-only recovery while preserving all accounting and objective', async () => {
    const result = await request({ threadId: existing.threadId, status: 'active', tokenBudget: 100, ownerConfirmed: true }, { authorized: true })
    expect(result.status).toBe(200)
    expect(result.body.result.goal).toMatchObject({ ...existing, status: 'active', tokenBudget: 100 })
    expect(appendGoalBudgetAuditRecord).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ previousTokensUsed: 50, resultingTokensUsed: 50, requestedTotalBudget: 100 }))
  })

  it('refuses implicit unlimited creation when an objective is provided without budget', async () => {
    const result = await request({ threadId: existing.threadId, objective: 'New objective', status: 'active' }, { authorized: true, before: null })
    expect(result.status).toBe(400)
    expect(result.writes).toHaveLength(0)
  })
  it('keeps objective-only edits on an existing Goal available without changing budget or usage', async () => {
    const result = await request({ threadId: existing.threadId, objective: 'Edited objective' })
    expect(result.status).toBe(200)
    expect(result.body.result.goal).toMatchObject({ tokenBudget: existing.tokenBudget, tokensUsed: existing.tokensUsed, objective: 'Edited objective' })
  })

  it.each([{ timeUsedSeconds: 0 }, { createdAt: 999 }, { threadId: 'foreign' }])('rejects changed durable accounting or target %j', async after => {
    const result = await request({ threadId: existing.threadId, status: 'active', tokenBudget: 100, ownerConfirmed: true }, { authorized: true, after })
    expect(result.status).toBe(502)
    expect(appendGoalBudgetAuditRecord).not.toHaveBeenCalled()
  })

  it.each([
    { before: null, objective: 'New finite objective', status: 'active', tokensUsed: 0 },
    { before: existing, objective: 'Edited objective', status: 'paused', tokensUsed: 50 },
  ])('allows owner-confirmed finite objective creation/edit %j with audit', async item => {
    const result = await request({ threadId: existing.threadId, objective: item.objective, status: item.status, tokenBudget: 100, ownerConfirmed: true }, { authorized: true, before: item.before })
    expect(result.status).toBe(200)
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]![1]).not.toHaveProperty('ownerConfirmed')
    expect(result.body.result.goal).toMatchObject({ objective: item.objective, tokenBudget: 100, tokensUsed: item.tokensUsed })
    expect(appendGoalBudgetAuditRecord).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ actor: 'owner', requestedTotalBudget: 100, resultingTokensUsed: item.tokensUsed }))
  })

  it.each([{}, { objective: existing.objective }, { status: 'paused' }])('requires explicit confirmation on every valid budget write %j', async shape => {
    const result = await request({ threadId: existing.threadId, status: 'active', tokenBudget: 100, ...shape }, { authorized: true })
    expect(result.status).toBe(400)
    expect(result.writes).toHaveLength(0)
    expect(appendGoalBudgetAuditRecord).not.toHaveBeenCalled()
  })

  it.each([null, '100', 0, -1, 100.5, Number.MAX_SAFE_INTEGER + 1])('rejects explicit invalid budget %s for an authorized owner', async tokenBudget => {
    const result = await request({ threadId: existing.threadId, status: 'paused', tokenBudget, ownerConfirmed: true }, { authorized: true })
    expect(result.status).toBe(400)
    expect(result.writes).toHaveLength(0)
    expect(appendGoalBudgetAuditRecord).not.toHaveBeenCalled()
  })

  it('denies an objective-present budget adjustment when owner is unauthorized', async () => {
    const result = await request({ threadId: existing.threadId, objective: existing.objective, status: 'active', tokenBudget: 100 })
    expect(result.status).toBe(403)
    expect(result.writes).toHaveLength(0)
    expect(appendGoalBudgetAuditRecord).not.toHaveBeenCalled()
  })
})
