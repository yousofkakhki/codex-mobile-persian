import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivityStore, redactActivityText } from './activityStore'
import type { ActivityInput } from '../types/activity'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-activity-store-test-'))
  directories.push(directory)
  return { directory, store: new ActivityStore(directory) }
}
function entry(id: string, threadId = 'thread-a'): ActivityInput {
  return { id, threadId, turnId: 'turn-a', itemId: null, goalCreatedAt: null, kind: 'command', status: 'running', title: 'Synthetic command', summary: '', startedAt: '2026-10-10T00:00:00.000Z', durationMs: null, hasDetail: false, reconstructed: false }
}

describe('durable activity store', () => {
  it('serializes concurrent writes and resumes pages after a process restart', async () => {
    const { store, directory } = await setup()
    await Promise.all(Array.from({ length: 60 }, (_, index) => store.append(entry('entry-' + index))))
    const first = await store.page('thread-a')
    expect(first.entries).toHaveLength(50)
    expect(first.entries[0].sequence).toBe(11)
    const restarted = new ActivityStore(directory)
    const earlier = await restarted.page('thread-a', { cursor: first.nextCursor! })
    expect(earlier.entries.map(value => value.sequence)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1))
    await restarted.append({ ...entry('entry-59'), status: 'completed' })
    const changes = await restarted.page('thread-a', { since: first.resumeCursor })
    expect(changes.entries).toHaveLength(1)
    expect(changes.entries[0].status).toBe('completed')
    expect(changes.entries[0].startedAt).toBe('2026-10-10T00:00:00.000Z')
    expect(changes.entries[0].order).toBe(60)
  })

  it('recovers an incomplete tail and never replaces captured provenance with backfill', async () => {
    const { store, directory } = await setup()
    await store.append(entry('original'))
    const threadDirectory = join(directory, createHash('sha256').update('thread-a').digest('hex'))
    await appendFile(join(threadDirectory, 'journals', '000000000001.jsonl'), '{"incomplete":')
    const restarted = new ActivityStore(directory)
    const recovered = await restarted.page('thread-a')
    expect(recovered.coverage.warning).toContain('incomplete')
    expect(recovered.entries).toHaveLength(1)
    await restarted.append({ ...entry('original'), reconstructed: true, summary: 'Old snapshot' })
    expect((await restarted.lookup('thread-a', 'original'))?.reconstructed).toBe(false)
  })

  it('redacts credentials across detail chunks and paginates UTF-8 without corrupting characters', async () => {
    const { store } = await setup()
    await store.setDetail('thread-a', 'detail', 'api_')
    await store.setDetail('thread-a', 'detail', 'key="fixture-private-value"\n' + 'سلام'.repeat(10000), true)
    let cursor: string | null = '0'
    let output = ''
    do {
      const part = await store.detail('thread-a', 'detail', cursor!)
      output += part.text
      cursor = part.nextCursor
    } while (cursor)
    expect(output).not.toContain('fixture-private-value')
    expect(output).not.toContain('�')
    expect(output).toContain('سلام'.repeat(10000))
    expect(redactActivityText('Bearer fixture-token https://owner:private@localhost/')).not.toContain('fixture-token')
    expect(redactActivityText('{"secret":"fixture-json-value"} https://example.com/?X-Amz-Signature=fixture-signature')).not.toContain('fixture-json-value')
    expect(redactActivityText('https://example.com/?X-Amz-Signature=fixture-signature')).not.toContain('fixture-signature')
  })

  it('reads only the requested tail from a 100,000-entry journal', async () => {
    const { directory } = await setup()
    const threadDirectory = join(directory, createHash('sha256').update('thread-a').digest('hex'))
    await mkdir(join(threadDirectory, 'journals'), { recursive: true })
    const segments = []
    for (let start = 1; start <= 100000; start += 512) {
      const count = Math.min(512, 100001 - start)
      const file = String(start).padStart(12, '0') + '.jsonl'
      const rows = Array.from({ length: count }, (_, index) => JSON.stringify({ ...entry('entry-' + (start + index)), sequence: start + index, updatedAt: '2026-10-10T00:00:00.000Z' })).join('\n') + '\n'
      await writeFile(join(threadDirectory, 'journals', file), rows)
      segments.push({ file, first: start, last: start + count - 1, count })
    }
    await writeFile(join(threadDirectory, 'manifest.json'), JSON.stringify({ version: 1, sequence: 100000, segments, coverage: { recordingSince: null, recoveredHistory: false, recoveryCursor: null, recoveryComplete: false, warning: null } }))
    const started = performance.now()
    const page = await new ActivityStore(directory).page('thread-a')
    const elapsed = performance.now() - started
    expect(page.entries).toHaveLength(50)
    expect(page.entries[0].sequence).toBe(99951)
    expect(elapsed).toBeLessThan(2000)
    expect((await readFile(join(threadDirectory, 'manifest.json'), 'utf8')).length).toBeLessThan(30000)
    console.log(`Activity 100k-entry tail page: ${elapsed.toFixed(1)} ms`)
  })
})
