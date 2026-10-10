import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivityCoverage, ActivityDetail, ActivityEntry, ActivityInput, ActivityPage } from '../types/activity.js'

const SEGMENT_RECORDS = 512
const DETAIL_PAGE_BYTES = 65536
type Segment = { file: string; first: number; last: number; count: number }
type Manifest = { version: 1; sequence: number; segments: Segment[]; coverage: ActivityCoverage }

export function redactActivityText(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+)?PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '[redacted credential]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:password|api[_ -]?key|access[_ -]?token|token|secret|cookie)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/([?&][\w-]*(?:code|signature|credential|auth|key|token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted credential]')
    .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[attachment data omitted]')
}

function emptyCoverage(): ActivityCoverage {
  return { recordingSince: null, recoveredHistory: false, recoveryCursor: null, recoveryComplete: false, warning: null }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, file)
}

export class ActivityStore {
  private readonly manifests = new Map<string, Manifest>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<(threadId: string, entry: ActivityEntry | null, coverage: ActivityCoverage) => void>()
  private readonly failures = new Map<string, string>()
  constructor(private readonly root: string) {}

  private directory(threadId: string): string { return join(this.root, digest(threadId)) }
  private snapshotPath(threadId: string, id: string): string { return join(this.directory(threadId), 'entries', digest(id) + '.json') }
  private detailPath(threadId: string, id: string): string { return join(this.directory(threadId), 'details', digest(id) + '.txt') }

  subscribe(listener: (threadId: string, entry: ActivityEntry | null, coverage: ActivityCoverage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(threadId: string, entry: ActivityEntry | null, coverage: ActivityCoverage): void {
    for (const listener of this.listeners) {
      try { listener(threadId, entry, { ...coverage, warning: this.failures.get(threadId) ?? coverage.warning }) } catch {}
    }
  }

  reportFailure(threadId: string): void {
    const warning = 'Activity recording failed. The task continues, but its history may have gaps.'
    this.failures.set(threadId, warning)
    const manifest = this.manifests.get(threadId)
    if (manifest) manifest.coverage.warning = warning
    this.publish(threadId, null, manifest?.coverage ?? emptyCoverage())
  }

  private serialized<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(threadId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.chains.set(threadId, next)
    void next.finally(() => { if (this.chains.get(threadId) === next) this.chains.delete(threadId) }).catch(() => {})
    return next
  }

  private async load(threadId: string): Promise<Manifest> {
    const cached = this.manifests.get(threadId)
    if (cached) return cached
    const directory = this.directory(threadId)
    await mkdir(join(directory, 'journals'), { recursive: true, mode: 0o700 })
    await mkdir(join(directory, 'entries'), { recursive: true, mode: 0o700 })
    await mkdir(join(directory, 'details'), { recursive: true, mode: 0o700 })
    let manifest: Manifest = { version: 1, sequence: 0, segments: [], coverage: emptyCoverage() }
    try {
      const stored = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest
      if (stored.version !== 1 || !Array.isArray(stored.segments)) throw new Error('Unsupported activity store')
      manifest = stored
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') manifest.coverage.warning = 'Activity metadata was recovered; some history may be unavailable.'
    }
    const persistedSequence = manifest.sequence
    const files = (await readdir(join(directory, 'journals'))).filter(file => /^\d{12}\.jsonl$/.test(file)).sort()
    const known = new Set(manifest.segments.slice(0, -1).map(segment => segment.file))
    for (const file of files.filter(file => !known.has(file))) {
      const journalPath = join(directory, 'journals', file)
      const contents = await readFile(journalPath, 'utf8')
      const completeEnd = contents.lastIndexOf('\n') + 1
      if (completeEnd < contents.length) {
        const handle = await open(journalPath, 'r+')
        try { await handle.truncate(Buffer.byteLength(contents.slice(0, completeEnd))) } finally { await handle.close() }
        manifest.coverage.warning = 'An incomplete activity record was recovered after interruption.'
      }
      const records: ActivityEntry[] = []
      for (const line of contents.slice(0, completeEnd).split('\n').filter(Boolean)) {
        try { records.push(JSON.parse(line) as ActivityEntry) } catch { manifest.coverage.warning = 'Some activity records could not be recovered.' }
      }
      if (!records.length) continue
      const segment = { file, first: records[0].sequence, last: records.at(-1)!.sequence, count: records.length }
      manifest.segments = [...manifest.segments.filter(value => value.file !== file), segment].sort((first, second) => first.first - second.first)
      manifest.sequence = Math.max(manifest.sequence, segment.last)
      for (const record of records.filter(record => record.sequence > persistedSequence)) await atomicJson(this.snapshotPath(threadId, record.id), record)
    }
    if (manifest.coverage.warning) this.failures.set(threadId, manifest.coverage.warning)
    await atomicJson(join(directory, 'manifest.json'), manifest)
    this.manifests.set(threadId, manifest)
    if (this.manifests.size > 32) {
      const removable = [...this.manifests.keys()].find(id => id !== threadId && !this.chains.has(id))
      if (removable) this.manifests.delete(removable)
    }
    return manifest
  }

  async lookup(threadId: string, id: string): Promise<ActivityEntry | null> {
    await this.chains.get(threadId)?.catch(() => {})
    try { return JSON.parse(await readFile(this.snapshotPath(threadId, id), 'utf8')) as ActivityEntry } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw failure
    }
  }

  append(input: ActivityInput): Promise<ActivityEntry> {
    return this.serialized(input.threadId, async () => {
      const manifest = await this.load(input.threadId)
      let existing: ActivityEntry | null = null
      try { existing = JSON.parse(await readFile(this.snapshotPath(input.threadId, input.id), 'utf8')) as ActivityEntry } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure
      }
      if (existing && input.reconstructed && !existing.reconstructed) return existing
      const updatedAt = input.updatedAt ?? new Date().toISOString()
      const candidate = {
        ...input,
        order: existing?.order ?? existing?.sequence ?? manifest.sequence + 1,
        title: redactActivityText(input.title),
        summary: redactActivityText(input.summary).slice(0, 240),
        startedAt: existing?.startedAt ?? input.startedAt,
        updatedAt,
      }
      if (existing && JSON.stringify({ ...existing, sequence: 0, updatedAt: '' }) === JSON.stringify({ ...candidate, sequence: 0, updatedAt: '' })) return existing
      const entry: ActivityEntry = { ...candidate, sequence: manifest.sequence + 1 }
      let segment = manifest.segments.at(-1)
      if (!segment || segment.count >= SEGMENT_RECORDS) {
        segment = { file: String(entry.sequence).padStart(12, '0') + '.jsonl', first: entry.sequence, last: entry.sequence, count: 0 }
        manifest.segments.push(segment)
      }
      await appendFile(join(this.directory(input.threadId), 'journals', segment.file), JSON.stringify(entry) + '\n', { mode: 0o600 })
      segment.last = entry.sequence
      segment.count++
      manifest.sequence = entry.sequence
      if (!entry.reconstructed && !manifest.coverage.recordingSince) manifest.coverage.recordingSince = updatedAt
      await atomicJson(this.snapshotPath(input.threadId, input.id), entry)
      await atomicJson(join(this.directory(input.threadId), 'manifest.json'), manifest)
      this.publish(input.threadId, entry, manifest.coverage)
      return entry
    })
  }

  setDetail(threadId: string, id: string, text: string, append = false, preserveLonger = false): Promise<void> {
    return this.serialized(threadId, async () => {
      await this.load(threadId)
      const file = this.detailPath(threadId, id)
      const content = redactActivityText(text)
      if (preserveLonger) {
        try {
          const existing = await open(file, 'r')
          try { if ((await existing.stat()).size > Buffer.byteLength(content)) return } finally { await existing.close() }
        } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
      }
      if (append) {
        const handle = await open(file, 'a+', 0o600)
        try {
          const size = (await handle.stat()).size
          const offset = Math.max(0, size - 4096)
          const tail = Buffer.alloc(size - offset)
          await handle.read(tail, 0, tail.length, offset)
          let boundary = 0
          while (boundary < tail.length && (tail[boundary] & 0xc0) === 0x80) boundary++
          const replacement = redactActivityText(tail.subarray(boundary).toString('utf8') + text)
          await handle.truncate(offset + boundary)
          await handle.write(Buffer.from(replacement, 'utf8'))
        } finally { await handle.close() }
      } else {
        const temporary = file + '.' + randomUUID() + '.tmp'
        await writeFile(temporary, content, { mode: 0o600 })
        await rename(temporary, file)
      }
    })
  }

  alias(threadId: string, alias: string, original: string): Promise<void> {
    return this.serialized(threadId, async () => {
      const entry = JSON.parse(await readFile(this.snapshotPath(threadId, original), 'utf8')) as ActivityEntry
      await atomicJson(this.snapshotPath(threadId, alias), entry)
    })
  }

  updateCoverage(threadId: string, update: Partial<ActivityCoverage>): Promise<void> {
    return this.serialized(threadId, async () => {
      const manifest = await this.load(threadId)
      manifest.coverage = { ...manifest.coverage, ...update }
      await atomicJson(join(this.directory(threadId), 'manifest.json'), manifest)
      this.publish(threadId, null, manifest.coverage)
    })
  }

  page(threadId: string, options: { cursor?: string; since?: string; limit?: number } = {}): Promise<ActivityPage> {
    return this.serialized(threadId, async () => {
      const manifest = await this.load(threadId)
      const limit = Math.max(1, Math.min(100, options.limit ?? 50))
      const cursor = options.cursor ? Number(options.cursor) : manifest.sequence + 1
      const since = options.since === undefined ? null : Number(options.since)
      if (!Number.isSafeInteger(cursor) || cursor < 1 || (since !== null && (!Number.isSafeInteger(since) || since < 0))) throw new Error('Invalid activity cursor')
      const segments = since === null ? [...manifest.segments].reverse() : manifest.segments
      const entries: ActivityEntry[] = []
      for (const segment of segments) {
        if (since === null ? segment.first >= cursor : segment.last <= since) continue
        const contents = await readFile(join(this.directory(threadId), 'journals', segment.file), 'utf8')
        const records = contents.split('\n').filter(Boolean).flatMap(line => {
          try { return [JSON.parse(line) as ActivityEntry] } catch { return [] }
        })
        for (const entry of since === null ? records.reverse() : records) {
          if (since === null ? entry.sequence >= cursor : entry.sequence <= since) continue
          entries.push(entry)
          if (entries.length === limit) break
        }
        if (entries.length === limit) break
      }
      const edge = entries.at(-1)?.sequence
      const hasMore = edge !== undefined && (since === null ? edge > 1 : edge < manifest.sequence)
      return {
        entries: since === null ? entries.reverse() : entries,
        nextCursor: hasMore ? String(edge) : null,
        resumeCursor: String(since === null ? manifest.sequence : edge ?? since),
        coverage: { ...manifest.coverage, warning: this.failures.get(threadId) ?? manifest.coverage.warning },
      }
    })
  }

  async detail(threadId: string, id: string, cursor = '0'): Promise<ActivityDetail> {
    await this.chains.get(threadId)?.catch(() => {})
    const offset = Number(cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid detail cursor')
    const file = this.detailPath(threadId, id)
    let handle
    try { handle = await open(file, 'r') } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', nextCursor: null }
      throw failure
    }
    try {
      const size = (await handle.stat()).size
      const buffer = Buffer.alloc(DETAIL_PAGE_BYTES + 4)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      let end = Math.min(bytesRead, DETAIL_PAGE_BYTES)
      if (offset + end < size) {
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
      }
      return { text: buffer.subarray(0, end).toString('utf8'), nextCursor: offset + end < size ? String(offset + end) : null }
    } finally { await handle.close() }
  }

  remove(threadId: string): Promise<void> {
    return this.serialized(threadId, async () => {
      await rm(this.directory(threadId), { recursive: true, force: true })
      this.manifests.delete(threadId)
      this.failures.delete(threadId)
    })
  }

  async flush(threadId?: string): Promise<void> {
    const promises = threadId ? [this.chains.get(threadId) ?? Promise.resolve()] : [...this.chains.values()]
    await Promise.all(promises.map(promise => promise.catch(() => {})))
  }
}
