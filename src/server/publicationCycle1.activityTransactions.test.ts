
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivityStore } from './activityStore'
import type { ActivityInput } from '../types/activity'

// Deterministic invalidation after the real filesystem effect, not a fake store.
const controls = vi.hoisted(() => ({ active: true, at: '', fired: false, invalidate: null as (() => void) | null, mkdirAfterRemoval: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real,
    mkdir: async (...args: Parameters<typeof real.mkdir>) => {
      if (controls.at === 'mkdir' && !controls.active) controls.mkdirAfterRemoval++
      const result = await real.mkdir(...args)
      if (controls.at === 'mkdir' && controls.active) { controls.active = false; controls.fired = true; controls.invalidate?.() }
      return result
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      const result = await real.rename(...args)
      if (controls.at === 'detail' && String(args[1]).endsWith('.txt')) { controls.active = false; controls.fired = true }
      return result
    },
    appendFile: async (...args: Parameters<typeof real.appendFile>) => {
      const result = await real.appendFile(...args)
      if (controls.at === 'journal') { controls.active = false; controls.fired = true }
      return result
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      const result = await real.writeFile(...args)
      if (controls.at === 'coverage' && String(args[0]).includes('manifest.json.')) { controls.active = false; controls.fired = true }
      return result
    },
  }
})
const roots: string[] = []
afterEach(async () => { controls.active = true; controls.at = ''; controls.fired = false; controls.invalidate = null; controls.mkdirAfterRemoval = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'cycle1-transactions-')); roots.push(root); return { root, store: new ActivityStore(root) } }
function entry(id: string): ActivityInput { return { id, threadId: 'a', turnId: null, itemId: null, goalCreatedAt: null, kind: 'command', status: 'completed', title: 'Synthetic', summary: '', startedAt: null, durationMs: null, hasDetail: false, reconstructed: true } }

it('PUB-ACT-02 rolls back a recovery journal append invalidated during filesystem completion', async () => {
  const { root, store } = await fixture()
  await store.append(entry('previous'))
  controls.at = 'journal'
  await store.append(entry('stale'), () => controls.active).catch(() => {})
  expect(controls.fired).toBe(true)
  expect((await store.page('a')).entries.some(value => value.id === 'stale')).toBe(false)
  const restarted = new ActivityStore(root)
  expect((await restarted.page('a')).entries.some(value => value.id === 'stale')).toBe(false)
  expect(await restarted.lookup('a', 'stale')).toBeNull()
  expect((await restarted.lookup('a', 'previous'))?.id).toBe('previous')
})

it('PUB-ACT-02 leaves cached and durable coverage unchanged when invalidated during temporary write', async () => {
  const { root, store } = await fixture()
  await store.page('a')
  controls.at = 'coverage'
  await store.updateCoverage('a', { recoveredHistory: true, recoveryComplete: true }, () => controls.active)
  expect(controls.fired).toBe(true)
  expect((await store.page('a')).coverage.recoveredHistory).toBe(false)
  expect((await new ActivityStore(root).page('a')).coverage.recoveredHistory).toBe(false)
})

it('PUB-ACT-02 restores previous redacted detail after generation changes during a snapshot rename', async () => {
  const { root, store } = await fixture()
  await store.setDetail('a', 'detail', 'prior public')
  controls.at = 'detail'
  await store.setDetail('a', 'detail', 'stale public', false, false, () => controls.active)
  expect(controls.fired).toBe(true)
  expect((await store.detail('a', 'detail')).text).toBe('prior public')
  expect((await new ActivityStore(root).detail('a', 'detail')).text).toBe('prior public')
})

it('PUB-ACT-02 stops metadata initialization after removal is confirmed during an awaited mkdir', async () => {
  const { store } = await fixture()
  let removal!: Promise<void>
  controls.at = 'mkdir'
  controls.invalidate = () => { removal = store.remove('a') }
  await store.page('a').catch(() => {})
  await removal
  expect(controls.fired).toBe(true)
  expect(controls.mkdirAfterRemoval).toBe(0)
})
