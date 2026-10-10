import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityStore } from './activityStore'
import { ActivityRecorder } from './activityRecorder'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-activity-recorder-test-'))
  directories.push(directory)
  const store = new ActivityStore(directory)
  return { store, recorder: new ActivityRecorder(store), directory }
}

describe('activity capture', () => {
  it('records a submission before dispatch and associates the accepted turn', async () => {
    const { store, recorder } = await setup()
    const params = { threadId: 'a', input: [{ type: 'text', text: 'Synthetic prompt' }] }
    const submission = await recorder.beforeRpc('turn/start', params)
    expect((await store.page('a')).entries[0].status).toBe('pending')
    recorder.notification({ method: 'item/completed', params: { threadId: 'a', turnId: 'turn-a', item: { id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'Synthetic prompt' }] } } })
    await recorder.afterRpc('turn/start', params, { turn: { id: 'turn-a' } }, submission)
    expect((await store.lookup('a', submission!))?.turnId).toBe('turn-a')
    expect((await store.detail('a', submission!)).text).toBe('Synthetic prompt')
    expect((await store.lookup('a', 'item:native-user'))?.id).toBe(submission)
  })

  it('merges streamed output and keeps background threads independent', async () => {
    const { store, recorder } = await setup()
    recorder.notification({ method: 'item/started', params: { threadId: 'a', turnId: 'turn-a', item: { id: 'cmd-a', type: 'commandExecution', command: 'echo synthetic' } } })
    for (let index = 0; index < 100; index++) recorder.notification({ method: 'item/commandExecution/outputDelta', params: { threadId: 'a', turnId: 'turn-a', itemId: 'cmd-a', delta: 'x' } })
    recorder.notification({ method: 'item/started', params: { threadId: 'b', turnId: 'turn-b', item: { id: 'cmd-b', type: 'commandExecution', command: 'other' } } })
    await recorder.flush()
    expect((await store.page('a')).entries.length).toBeLessThanOrEqual(2)
    expect((await store.detail('a', 'item:cmd-a')).text).toBe('x'.repeat(100))
    recorder.notification({ method: 'item/completed', params: { threadId: 'a', turnId: 'turn-a', item: { id: 'cmd-a', type: 'commandExecution', command: 'echo synthetic', aggregatedOutput: 'Truncated summary', exitCode: 0 } } })
    await recorder.flush()
    expect((await store.lookup('a', 'item:cmd-a'))?.status).toBe('completed')
    expect((await store.detail('a', 'item:cmd-a')).text).toBe('x'.repeat(100))
    expect((await store.page('b')).entries.every(value => value.threadId === 'b')).toBe(true)
  })

  it('captures queue, goal, approval, and completion lifecycle records', async () => {
    const { store, recorder } = await setup()
    recorder.recordQueue({}, { a: [{ id: 'queued', text: 'Synthetic queue entry' }] })
    recorder.notification({ method: 'thread/goal/updated', params: { threadId: 'a', goal: { createdAt: 1, updatedAt: 2, status: 'active', objective: 'Synthetic goal', tokensUsed: 7, timeUsedSeconds: 2, tokenBudget: null } } })
    recorder.notification({ method: 'server/request', params: { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'a', turnId: 'turn-a', command: 'echo fixture' } } })
    recorder.notification({ method: 'server/request/resolved', params: { id: 42, threadId: 'a', method: 'item/commandExecution/requestApproval' } })
    recorder.notification({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'turn-a', status: 'completed', durationMs: 100 } } })
    await recorder.flush()
    expect((await store.lookup('a', 'approval:turn-a:42'))?.status).toBe('completed')
    expect((await store.page('a')).entries.find(value => value.title === 'Goal usage')?.summary).toContain('7 tokens')
    expect((await store.lookup('a', 'queue:queued'))?.status).toBe('pending')
    expect((await store.lookup('a', 'turn:turn-a'))?.durationMs).toBe(100)
  })

  it('backfills paginated items once and labels unknown historical timestamps', async () => {
    const { store, recorder } = await setup()
    const rpc = vi.fn(async (_method: string, _params: unknown) => ({ data: [{ turnId: 'old-turn', item: { id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: 'Old synthetic prompt' }] } }], nextCursor: 'older' }))
    await Promise.all([recorder.recover('a', { rpc }), recorder.recover('a', { rpc })])
    await recorder.recover('a', { rpc })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/items/list', { threadId: 'a', limit: 100, sortDirection: 'desc' })
    const recovered = await store.lookup('a', 'item:old-user')
    expect(recovered?.reconstructed).toBe(true)
    expect(recovered?.startedAt).toBeNull()
    await recorder.recover('a', { rpc }, true)
    expect(rpc.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'older' })
    expect((await store.page('a')).coverage.recoveredHistory).toBe(true)
  })

  it('keeps newer goal usage during an overlapping read and records clear only once', async () => {
    const { recorder, store } = await setup()
    const request = await recorder.beforeRpc('thread/goal/get', { threadId: 'a' })
    const goal = { createdAt: 1, updatedAt: 2, status: 'active', objective: 'Fixture goal', tokensUsed: 50, timeUsedSeconds: 5, tokenBudget: 100 }
    recorder.notification({ method: 'thread/goal/updated', params: { threadId: 'a', goal } })
    await recorder.afterRpc('thread/goal/get', { threadId: 'a' }, { goal: { ...goal, tokensUsed: 1 } }, request)
    recorder.notification({ method: 'thread/goal/cleared', params: { threadId: 'a' } })
    await recorder.afterRpc('thread/goal/clear', { threadId: 'a' }, { cleared: true }, null)
    await recorder.flush()
    const entries = (await store.page('a')).entries
    expect(entries.filter(entry => entry.title === 'Goal cleared')).toHaveLength(1)
    expect(entries.find(entry => entry.title === 'Goal usage')?.summary).toContain('50 tokens')
  })

  it('preserves archives, deletes only confirmed deletions, and surfaces recording failures', async () => {
    const { store, recorder, directory } = await setup()
    await recorder.beforeRpc('turn/start', { threadId: 'a', input: [{ type: 'text', text: 'Fixture' }] })
    await recorder.afterRpc('thread/archive', { threadId: 'a' }, {}, null)
    expect((await store.page('a')).entries).not.toHaveLength(0)
    await recorder.afterRpc('thread/delete', { threadId: 'a' }, {}, null)
    expect((await store.page('a')).entries).toHaveLength(0)
    const invalid = join(directory, 'file-not-directory')
    await writeFile(invalid, 'fixture')
    const failedStore = new ActivityStore(invalid)
    const warnings: string[] = []
    failedStore.subscribe((_thread, _entry, coverage) => { if (coverage.warning) warnings.push(coverage.warning) })
    await new ActivityRecorder(failedStore).beforeRpc('turn/start', { threadId: 'b', input: [] })
    expect(warnings[0]).toContain('history may have gaps')
  })
})
