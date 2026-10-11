import { afterEach, describe, expect, it, vi } from 'vitest'
import { resumeThreadGoal, setThreadGoal } from './codexGateway'
afterEach(() => vi.unstubAllGlobals())
const before = { threadId: 'confirmation-fixture', objective: 'Preserve', status: 'budgetLimited', tokenBudget: 50, tokensUsed: 50, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 }
function fixture() {
  const requests: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    if (url === '/codex-api/owner/authorization') return Response.json({ authorized: true })
    const body = JSON.parse(init.body); requests.push(body)
    return Response.json({ result: { goal: body.method === 'thread/goal/get' ? before : { ...before, status: 'active', tokenBudget: 100 } } })
  }))
  return requests
}
describe('explicit Goal budget confirmation propagation', () => {
  it('forwards explicit recovery confirmation without replacing the objective', async () => {
    const requests = fixture()
    await resumeThreadGoal(before.threadId, 100, true)
    expect(requests.at(-1).params).toEqual({ threadId: before.threadId, status: 'active', tokenBudget: 100, ownerConfirmed: true })
  })

  it('does not issue a recovery write without caller confirmation', async () => {
    const requests = fixture()
    await expect(resumeThreadGoal(before.threadId, 100)).rejects.toThrow(/confirmation/i)
    expect(requests.filter(r => r.method === 'thread/goal/set')).toHaveLength(0)
  })
  it('forwards explicit caller confirmation on finite creation/update', async () => {
    const requests = fixture()
    await setThreadGoal(before.threadId, { objective: 'Preserve', status: 'active', tokenBudget: 100, ownerConfirmed: true } as any)
    expect(requests.at(-1).params.ownerConfirmed).toBe(true)
  })
})
