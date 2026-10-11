import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivityStore } from './activityStore'
import { ActivityRecorder } from './activityRecorder'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'publication-cycle1-deletion-'))
  roots.push(root)
  const store = new ActivityStore(root)
  return { root, store, recorder: new ActivityRecorder(store) }
}
async function absent(root: string) {
  await expect(readdir(join(root, createHash('sha256').update('a').digest('hex')))).rejects.toMatchObject({ code: 'ENOENT' })
}
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (failure: Error) => void
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function started(rpc: ReturnType<typeof vi.fn>) {
  for (let tries = 0; tries < 200 && !rpc.mock.calls.length; tries++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(rpc).toHaveBeenCalledTimes(1)
}

it('PUB-ACT-02 suppresses late recovery failure coverage and unsupported fallback after deletion', async () => {
  const { root, recorder, store } = await fixture()
  const waiting = deferred()
  const rpc = vi.fn(() => waiting.promise)
  const recovery = recorder.recover('a', { rpc })
  await started(rpc)
  await recorder.afterRpc('thread/delete', { threadId: 'a' }, {}, null)
  waiting.reject(new Error('method not found'))
  await recovery
  expect(rpc).toHaveBeenCalledTimes(1)
  await absent(root)
  await store.page('a')
  await recorder.recover('a', { rpc }, true)
  await absent(root)
})

it('PUB-ACT-02 tombstones direct store reads and coverage writes after removal', async () => {
  const { root, store } = await fixture()
  await store.updateCoverage('a', { recoveredHistory: true })
  await store.remove('a')
  await store.updateCoverage('a', { warning: 'late synthetic warning' }).catch(() => {})
  expect((await store.page('a')).entries).toEqual([])
  await store.setDetail('a', 'late', 'synthetic public').catch(() => {})
  await absent(root)
})

it('PUB-ACT-02 discards stale process-identity recovery without coverage commit', async () => {
  const { recorder, store } = await fixture()
  const waiting = deferred()
  const executor = { process: {}, rpc: vi.fn(() => waiting.promise) }
  const recovery = recorder.recover('a', executor)
  await started(executor.rpc)
  executor.process = {}
  waiting.resolve({ data: [], nextCursor: 'old-generation' })
  await recovery
  expect((await store.page('a')).coverage.recoveredHistory).toBe(false)
})

it('PUB-ACT-02 closed-thread epoch invalidates old recovery and does not delete captured activity', async () => {
  const { recorder, store } = await fixture()
  await recorder.beforeRpc('turn/start', { threadId: 'a', input: [{ type: 'text', text: 'synthetic public' }] })
  const waiting = deferred()
  const rpc = vi.fn(() => waiting.promise)
  const recovery = recorder.recover('a', { rpc })
  await started(rpc)
  recorder.notification({ method: 'thread/closed', params: { threadId: 'a' } })
  waiting.resolve({ data: [], nextCursor: 'old-epoch' })
  await recovery
  const page = await store.page('a')
  expect(page.coverage.recoveredHistory).toBe(false)
  expect(page.entries).toHaveLength(1)
})

it('PUB-ACT-02 does not attribute a cold rejected recovery to a replacement process', async () => {
  const { recorder, store } = await fixture()
  const waiting = deferred()
  const executor = { process: null as object | null, rpc: vi.fn(() => waiting.promise) }
  const recovery = recorder.recover('a', executor)
  await started(executor.rpc)
  executor.process = {}
  waiting.reject(new Error('retired acquisition failed'))
  await recovery
  expect((await store.page('a')).coverage.warning).toBeNull()
})

it('PUB-ACT-02 retains successful cold acquisition and current-generation unsupported-method fallback', async () => {
  const { recorder, store } = await fixture()
  const executor = { process: null as object | null, rpc: vi.fn(async () => { executor.process = {}; return { data: [], nextCursor: null } }) }
  await recorder.recover('a', executor)
  expect((await store.page('a')).coverage.recoveryComplete).toBe(true)
  const warm = { process: {}, rpc: vi.fn().mockRejectedValueOnce(new Error('method not found')).mockResolvedValueOnce({ data: [], nextCursor: null }) }
  await recorder.recover('b', warm)
  expect(warm.rpc.mock.calls.map(call => call[0])).toEqual(['thread/items/list', 'thread/turns/list'])
  expect((await store.page('b')).coverage.recoveryComplete).toBe(true)
})
