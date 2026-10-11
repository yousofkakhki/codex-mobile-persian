import { createHash, randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivityCoverage, ActivityDetail, ActivityEntry, ActivityInput, ActivityPage } from '../types/activity.js'

const SEGMENT_RECORDS = 512
const DETAIL_PAGE_BYTES = 65536
type Segment = { file: string; first: number; last: number; count: number }
type Manifest = { version: 1; sequence: number; segments: Segment[]; coverage: ActivityCoverage }

type RedactionState = {
  version: 1; mode: 'text' | 'value' | 'quoted' | 'token' | 'key' | 'blocked'
  pending: string; quote: string; escaped: boolean; keyEnd: string; keyIndex: number; keyBegin: string
}
const credentialNames = ['password', 'api_key', 'api-key', 'api key', 'apikey', 'access_token', 'access-token', 'access token', 'accesstoken', 'token', 'secret', 'cookie', 'bearer']
function redactionState(): RedactionState {
  return { version: 1, mode: 'text', pending: '', quote: '', escaped: false, keyEnd: '', keyIndex: 0, keyBegin: '' }
}
// Only public recognizer prefixes are retained. Value/key bodies never enter this
// bounded state, including while a delimiter itself is split between flushes.
function possibleRedactionPrefix(value: string): boolean {
  const lower = value.toLowerCase()
  const keyPrefix = '-----BEGIN '
  if (keyPrefix.startsWith(value) || value.startsWith(keyPrefix) && /^[A-Z ]*-{0,5}$/.test(value.slice(keyPrefix.length))) return true
  const name = lower.replace(/^["']/, '')
  return credentialNames.some(candidate => candidate.startsWith(name) || name.startsWith(candidate) && /^["']?\s*$/.test(name.slice(candidate.length)))
}
function streamRedaction(previous: RedactionState, chunk: string): { text: string; state: RedactionState } {
  const state = { ...previous, pending: '' }
  const source = previous.pending + chunk
  const output: string[] = []
  for (let index = 0; index < source.length;) {
    const character = source[index]
    if (state.mode === 'blocked') break // Legacy/uncertain append fails closed until full replacement.
    if (state.mode === 'key') {
      // A bounded prefix matcher retains indices, never a private-key body tail.
      const prefix = state.keyEnd.slice(0, state.keyIndex) + character
      let matched = Math.min(prefix.length, state.keyEnd.length)
      while (matched && !prefix.endsWith(state.keyEnd.slice(0, matched))) matched--
      state.keyIndex = matched
      if (matched === state.keyEnd.length) { state.mode = state.quote ? 'quoted' : 'text'; state.keyIndex = 0 }
      index++
      continue
    }
    // PEM recognition is independent of assignment/quote parsing: consuming a
    // credential value must not consume and lose the opening key delimiter.
    const beginning = state.keyBegin + character
    if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----$/.test(beginning)) {
      state.mode = 'key'; state.keyEnd = beginning.replace('BEGIN', 'END'); state.keyIndex = 0; state.keyBegin = ''
      output.push('[redacted private key]'); index++
      continue
    }
    state.keyBegin = '-----BEGIN '.startsWith(beginning) || beginning.startsWith('-----BEGIN ') && /^[A-Z ]*-{0,5}$/.test(beginning.slice(11)) ? beginning : character === '-' ? '-' : ''
    if (state.keyBegin.length > 100) { output.push('[redacted private key]'); state.mode = 'blocked'; break }
    if (state.mode === 'quoted') {
      if (state.escaped) state.escaped = false
      else if (character === '\\') state.escaped = true
      else if (character === state.quote) { state.mode = 'text'; state.quote = '' }
      index++
      continue
    }
    if (state.mode === 'value') {
      if (/\s/.test(character)) { index++; continue }
      if (character === '"' || character === "'") { state.mode = 'quoted'; state.quote = character; index++; continue }
      state.mode = 'token'
    }
    if (state.mode === 'token') {
      if (!/[\s,"'}]/.test(character)) { index++; continue }
      state.mode = 'text'
    }
    const remaining = source.slice(index)
    const key = remaining.match(/^-----BEGIN ([A-Z ]{0,64}PRIVATE KEY)-----/)
    if (key) {
      state.mode = 'key'; state.keyEnd = `-----END ${key[1]}-----`; state.keyIndex = 0; state.keyBegin = ''
      output.push('[redacted private key]'); index += key[0].length
      continue
    }
    const credential = remaining.match(/^(?:["']?(?:password|api[_ -]?key|access[_ -]?token|token|secret|cookie)["']?\s*[:=]\s*|Bearer\s+)/i)
    if (credential) {
      output.push(credential[0], '[redacted]'); state.mode = 'value'; index += credential[0].length
      continue
    }
    if (!state.keyBegin && remaining.length <= 256 && possibleRedactionPrefix(remaining)) { state.pending = remaining; output.push(remaining); break }
    // An overlong ambiguous header is not allowed to become unbounded state.
    if (remaining.startsWith('-----BEGIN ') && /^[A-Z ]{65}/.test(remaining.slice(11))) {
      output.push('[redacted private key]'); state.mode = 'blocked'; break
    }
    output.push(character); index++
  }
  return { text: output.join(''), state }
}
function redactRecognizedText(text: string): string {
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

export function redactActivityText(text: string): string {
  return redactRecognizedText(streamRedaction(redactionState(), text).text)
}

function validRedactionState(value: RedactionState): boolean {
  return value.version === 1 && ['text', 'value', 'quoted', 'token', 'key', 'blocked'].includes(value.mode)
    && typeof value.pending === 'string' && value.pending.length <= 256 && (!value.pending || possibleRedactionPrefix(value.pending))
    && ['', '"', "'"].includes(value.quote) && typeof value.escaped === 'boolean'
    && typeof value.keyEnd === 'string' && value.keyEnd.length <= 100
    && (!value.keyEnd || /^-----END [A-Z ]*PRIVATE KEY-----$/.test(value.keyEnd))
    && Number.isSafeInteger(value.keyIndex) && value.keyIndex >= 0 && value.keyIndex <= value.keyEnd.length
    && typeof value.keyBegin === 'string' && value.keyBegin.length <= 100
    && (!value.keyBegin || '-----BEGIN '.startsWith(value.keyBegin) || value.keyBegin.startsWith('-----BEGIN ') && /^[A-Z ]*-{0,5}$/.test(value.keyBegin.slice(11)))
}

function emptyCoverage(): ActivityCoverage {
  return { recordingSince: null, recoveredHistory: false, recoveryCursor: null, recoveryComplete: false, warning: null }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

async function atomicJson(file: string, value: unknown, current: () => boolean = () => true): Promise<void> {
  if (!current()) return
  const temporary = file + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  if (!current()) { await rm(temporary, { force: true }); return }
  await rename(temporary, file)
}

export class ActivityStore {
  private readonly manifests = new Map<string, Manifest>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<(threadId: string, entry: ActivityEntry | null, coverage: ActivityCoverage) => void>()
  private readonly failures = new Map<string, string>()
  private readonly removed = new Set<string>()
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
    if (this.removed.has(threadId)) return
    const warning = 'Activity recording failed. The task continues, but its history may have gaps.'
    this.failures.set(threadId, warning)
    const manifest = this.manifests.get(threadId)
    if (manifest) manifest.coverage.warning = warning
    this.publish(threadId, null, manifest?.coverage ?? emptyCoverage())
  }

  private serialized<T>(threadId: string, operation: () => Promise<T>, removal = false): Promise<T> {
    const previous = this.chains.get(threadId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => {
      if (!removal && this.removed.has(threadId)) throw new Error('Activity thread was permanently deleted')
      return operation()
    })
    this.chains.set(threadId, next)
    void next.finally(() => { if (this.chains.get(threadId) === next) this.chains.delete(threadId) }).catch(() => {})
    return next
  }

  private async load(threadId: string, current: () => boolean = () => true): Promise<Manifest> {
    const assertCurrent = () => {
      if (this.removed.has(threadId) || !current()) throw new Error('Activity thread was deleted or recovery is no longer current')
    }
    assertCurrent()
    const cached = this.manifests.get(threadId)
    if (cached) return cached
    const directory = this.directory(threadId)
    await mkdir(join(directory, 'journals'), { recursive: true, mode: 0o700 })
    assertCurrent()
    await mkdir(join(directory, 'entries'), { recursive: true, mode: 0o700 })
    assertCurrent()
    await mkdir(join(directory, 'details'), { recursive: true, mode: 0o700 })
    assertCurrent()
    let manifest: Manifest = { version: 1, sequence: 0, segments: [], coverage: emptyCoverage() }
    try {
      const stored = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest
      assertCurrent()
      if (stored.version !== 1 || !Array.isArray(stored.segments)) throw new Error('Unsupported activity store')
      manifest = stored
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') manifest.coverage.warning = 'Activity metadata was recovered; some history may be unavailable.'
    }
    const persistedSequence = manifest.sequence
    assertCurrent()
    const files = (await readdir(join(directory, 'journals'))).filter(file => /^\d{12}\.jsonl$/.test(file)).sort()
    assertCurrent()
    const known = new Set(manifest.segments.slice(0, -1).map(segment => segment.file))
    for (const file of files.filter(file => !known.has(file))) {
      const journalPath = join(directory, 'journals', file)
      const contents = await readFile(journalPath, 'utf8')
      assertCurrent()
      const completeEnd = contents.lastIndexOf('\n') + 1
      if (completeEnd < contents.length) {
        const handle = await open(journalPath, 'r+')
        try { assertCurrent(); await handle.truncate(Buffer.byteLength(contents.slice(0, completeEnd))) } finally { await handle.close() }
        assertCurrent()
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
      // Tail recovery is bounded to this retained segment, not the whole journal.
      // An acknowledged sequence is not evidence that its snapshot still exists.
      for (const record of records) {
        const snapshot = this.snapshotPath(threadId, record.id)
        let stored: ActivityEntry | null = null
        try { stored = JSON.parse(await readFile(snapshot, 'utf8')) as ActivityEntry } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') manifest.coverage.warning = 'Some activity snapshots were recovered from the retained journal.'
        }
        assertCurrent()
        if (!stored || stored.sequence < record.sequence || record.sequence > persistedSequence) await atomicJson(snapshot, record, current)
        assertCurrent()
      }
    }
    if (manifest.coverage.warning) this.failures.set(threadId, manifest.coverage.warning)
    assertCurrent()
    await atomicJson(join(directory, 'manifest.json'), manifest, current)
    assertCurrent()
    this.manifests.set(threadId, manifest)
    if (this.manifests.size > 32) {
      const removable = [...this.manifests.keys()].find(id => id !== threadId && !this.chains.has(id))
      if (removable) this.manifests.delete(removable)
    }
    return manifest
  }

  async lookup(threadId: string, id: string): Promise<ActivityEntry | null> {
    await this.chains.get(threadId)?.catch(() => {})
    if (this.removed.has(threadId)) return null
    try { return JSON.parse(await readFile(this.snapshotPath(threadId, id), 'utf8')) as ActivityEntry } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw failure
    }
  }

  append(input: ActivityInput, current: () => boolean = () => !this.removed.has(input.threadId)): Promise<ActivityEntry> {
    return this.serialized(input.threadId, async () => {
      if (!current()) throw new Error('Activity recovery is no longer current')
      const manifest = await this.load(input.threadId, current)
      if (!current()) throw new Error('Activity recovery is no longer current')
      let existing: ActivityEntry | null = null
      try { existing = JSON.parse(await readFile(this.snapshotPath(input.threadId, input.id), 'utf8')) as ActivityEntry } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure
      }
      if (!current()) throw new Error('Activity recovery is no longer current')
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
      const nextManifest: Manifest = { ...manifest, segments: manifest.segments.map(value => ({ ...value })), coverage: { ...manifest.coverage } }
      let segment = nextManifest.segments.at(-1)
      if (!segment || segment.count >= SEGMENT_RECORDS) {
        segment = { file: String(entry.sequence).padStart(12, '0') + '.jsonl', first: entry.sequence, last: entry.sequence, count: 0 }
        nextManifest.segments.push(segment)
      }
      const journalPath = join(this.directory(input.threadId), 'journals', segment.file)
      const journal = await open(journalPath, 'a+', 0o600)
      const size = (await journal.stat()).size
      const snapshot = this.snapshotPath(input.threadId, input.id)
      const metadata = join(this.directory(input.threadId), 'manifest.json')
      let appended = false
      try {
        if (!current()) throw new Error('Activity recovery is no longer current')
        appended = true
        await appendFile(journalPath, JSON.stringify(entry) + '\n', { mode: 0o600 })
        if (!current()) throw new Error('Activity recovery is no longer current')
        segment.last = entry.sequence
        segment.count++
        nextManifest.sequence = entry.sequence
        if (!entry.reconstructed && !nextManifest.coverage.recordingSince) nextManifest.coverage.recordingSince = updatedAt
        await atomicJson(snapshot, entry, current)
        if (!current()) throw new Error('Activity recovery is no longer current')
        await atomicJson(metadata, nextManifest, current)
        if (!current()) throw new Error('Activity recovery is no longer current')
        this.manifests.set(input.threadId, nextManifest)
        this.publish(input.threadId, entry, nextManifest.coverage)
        return entry
      } finally {
        // Per-thread serialization excludes competing writes while cancellation
        // restores the exact acknowledged state, including restart-visible bytes.
        try {
          if (appended && !current()) {
            await journal.truncate(size)
            if (existing) await atomicJson(snapshot, existing)
            else await rm(snapshot, { force: true })
            await atomicJson(metadata, manifest)
          }
        } finally { await journal.close() }
      }
    })
  }

  setDetail(threadId: string, id: string, text: string, append = false, preserveLonger = false, current: () => boolean = () => !this.removed.has(threadId)): Promise<void> {
    return this.serialized(threadId, async () => {
      if (!current()) return
      await this.load(threadId, current)
      if (!current()) return
      const file = this.detailPath(threadId, id)
      const stateFile = file + '.redaction.json'
      const complete = streamRedaction(redactionState(), text)
      const content = redactRecognizedText(complete.text)
      if (preserveLonger) {
        try {
          const existing = await open(file, 'r')
          try { if ((await existing.stat()).size > Buffer.byteLength(content)) return } finally { await existing.close() }
        } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
      }
      if (!current()) return
      // Crash between detail and state commits must fail closed, not guess from a
      // redaction marker that has already discarded the original opening span.
      const blocked: RedactionState = { ...redactionState(), mode: 'blocked' }
      if (append) {
        const handle = await open(file, 'a+', 0o600)
        try {
          const size = (await handle.stat()).size
          let previous = size ? blocked : redactionState()
          try {
            const stored = JSON.parse(await readFile(stateFile, 'utf8')) as RedactionState
            if (validRedactionState(stored)) previous = stored
          } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') previous = blocked }
          const streamed = streamRedaction(previous, text)
          const offset = Math.max(0, size - 4096)
          const tail = Buffer.alloc(size - offset)
          await handle.read(tail, 0, tail.length, offset)
          let boundary = 0
          while (boundary < tail.length && (tail[boundary] & 0xc0) === 0x80) boundary++
          const prefixBytes = Buffer.byteLength(previous.pending)
          if (prefixBytes && !tail.subarray(tail.length - prefixBytes).equals(Buffer.from(previous.pending))) {
            await atomicJson(stateFile, blocked, current)
            if (current()) this.reportFailure(threadId)
            return
          }
          const safeTail = tail.subarray(boundary, tail.length - prefixBytes).toString('utf8')
          const replacement = redactRecognizedText(safeTail + streamed.text)
          if (!current()) return
          await atomicJson(stateFile, blocked, current)
          if (!current()) return
          await handle.truncate(offset + boundary)
          if (!current()) return
          await handle.write(Buffer.from(replacement, 'utf8'))
          await atomicJson(stateFile, streamed.state, current)
          if (current() && previous.mode === 'blocked') this.reportFailure(threadId)
        } finally { await handle.close() }
      } else {
        const temporary = file + '.' + randomUUID() + '.tmp'
        const backup = temporary + '.previous'
        const stateBackup = backup + '.state'
        let hadDetail = false
        let hadState = false
        try {
          // Filesystem copies retain constant memory even for a long detail.
          try { await copyFile(file, backup); hadDetail = true } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
          try { await copyFile(stateFile, stateBackup); hadState = true } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
          if (!current()) return
          await atomicJson(stateFile, blocked, current)
          if (!current()) return
          await writeFile(temporary, content, { mode: 0o600 })
          if (!current()) return
          await rename(temporary, file)
          await atomicJson(stateFile, complete.state, current)
        } finally {
          if (!current()) {
            if (hadDetail) await rename(backup, file)
            else await rm(file, { force: true })
            if (hadState) await rename(stateBackup, stateFile)
            else await rm(stateFile, { force: true })
          }
          await Promise.all([temporary, backup, stateBackup].map(path => rm(path, { force: true })))
        }
      }
    })
  }

  alias(threadId: string, alias: string, original: string): Promise<void> {
    return this.serialized(threadId, async () => {
      const entry = JSON.parse(await readFile(this.snapshotPath(threadId, original), 'utf8')) as ActivityEntry
      await atomicJson(this.snapshotPath(threadId, alias), entry)
    })
  }

  updateCoverage(threadId: string, update: Partial<ActivityCoverage>, current: () => boolean = () => !this.removed.has(threadId)): Promise<void> {
    if (this.removed.has(threadId) || !current()) return Promise.resolve()
    return this.serialized(threadId, async () => {
      if (!current()) return
      const manifest = await this.load(threadId, current)
      if (!current()) return
      const nextManifest: Manifest = { ...manifest, coverage: { ...manifest.coverage, ...update } }
      const metadata = join(this.directory(threadId), 'manifest.json')
      await atomicJson(metadata, nextManifest, current)
      if (!current()) { await atomicJson(metadata, manifest); return }
      this.manifests.set(threadId, nextManifest)
      this.publish(threadId, null, nextManifest.coverage)
    })
  }

  page(threadId: string, options: { cursor?: string; since?: string; limit?: number } = {}): Promise<ActivityPage> {
    if (this.removed.has(threadId)) return Promise.resolve({ entries: [], nextCursor: null, resumeCursor: '0', coverage: emptyCoverage() })
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
    if (this.removed.has(threadId)) return { text: '', nextCursor: null }
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
    this.removed.add(threadId)
    return this.serialized(threadId, async () => {
      await rm(this.directory(threadId), { recursive: true, force: true })
      this.manifests.delete(threadId)
      this.failures.delete(threadId)
    }, true)
  }

  async flush(threadId?: string): Promise<void> {
    const promises = threadId ? [this.chains.get(threadId) ?? Promise.resolve()] : [...this.chains.values()]
    await Promise.all(promises.map(promise => promise.catch(() => {})))
  }
}
