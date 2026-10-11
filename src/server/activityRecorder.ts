import { createHash, randomUUID } from 'node:crypto'
import type { ActivityInput, ActivityKind, ActivityStatus } from '../types/activity.js'
import { ActivityStore, redactActivityText } from './activityStore.js'

type RecoveryReadLease = { rpc(method: string, params: unknown): Promise<unknown>; isCurrent(): boolean }
type RpcExecutor = {
  rpc(method: string, params: unknown): Promise<unknown>
  createActivityRecoveryLease?(threadId: string): RecoveryReadLease
}
type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {} }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString()
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

function itemKind(type: string): ActivityKind {
  if (type === 'userMessage') return 'prompt'
  if (type === 'agentMessage') return 'message'
  if (type === 'commandExecution') return 'command'
  if (type === 'fileChange') return 'fileChange'
  if (type === 'plan' || type === 'reasoning') return 'plan'
  return 'tool'
}

function itemTitle(type: string, item: RecordValue): string {
  if (type === 'userMessage') return 'Prompt'
  if (type === 'agentMessage') return item.phase === 'commentary' ? 'Assistant update' : 'Assistant response'
  if (type === 'commandExecution') return text(item.command) || 'Command'
  if (type === 'fileChange') return 'File changes'
  if (type === 'reasoning') return 'Reasoning summary'
  if (type === 'plan') return 'Plan'
  return text(item.tool) || text(item.name) || type.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function itemDetail(type: string, item: RecordValue): string {
  if (type === 'userMessage') return (Array.isArray(item.content) ? item.content : []).map(part => {
    const value = record(part)
    return value.type === 'text' ? text(value.text) : `[${text(value.type) || 'attachment'}]`
  }).join('\n')
  if (type === 'agentMessage' || type === 'plan') return text(item.text)
  if (type === 'reasoning') return (Array.isArray(item.summary) ? item.summary : []).map(part => typeof part === 'string' ? part : text(record(part).text)).join('\n')
  if (type === 'commandExecution') return text(item.aggregatedOutput)
  if (type === 'fileChange') return (Array.isArray(item.changes) ? item.changes : []).map(change => {
    const value = record(change)
    return `${text(value.path)}\n${text(value.diff)}`
  }).join('\n\n')
  return JSON.stringify(item, (key, value) => /authorization|api.?key|password|secret|encrypted|base64|token|cookie/i.test(key) ? '[omitted]' : value, 2)
}

export class ActivityRecorder {
  private readonly pending = new Map<string, { input: ActivityInput; chunks: string[] }>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly deleted = new Set<string>()
  private readonly recoveryEpochs = new Map<string, number>()
  private readonly submittedTurns = new Map<string, string>()
  private readonly pendingSubmissions = new Map<string, string>()
  private readonly recovering = new Map<string, Promise<void>>()
  private readonly lastGoals = new Map<string, { status: string; updatedAt: number; createdAt: number; identity: string }>()
  private readonly goalRevisions = new Map<string, number>()
  private readonly requestGoalRevisions = new Map<string, number>()
  private readonly clearedGoals = new Set<string>()
  private readonly approvalEntries = new Map<string, { id: string; turnId: string | null }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(readonly store: ActivityStore) {}

  private input(threadId: string, id: string, kind: ActivityKind, title: string, status: ActivityStatus = 'running'): ActivityInput {
    return { id, threadId, turnId: null, itemId: null, goalCreatedAt: null, kind, title, status, summary: '', startedAt: new Date().toISOString(), durationMs: null, hasDetail: false, reconstructed: false }
  }

  private run(threadId: string, operation: () => Promise<void>, current: () => boolean = () => true): Promise<void> {
    const previous = this.chains.get(threadId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => { if (!this.deleted.has(threadId) && current()) await operation() })
      .catch(() => { if (!this.deleted.has(threadId) && current()) this.store.reportFailure(threadId) })
    this.chains.set(threadId, next)
    void next.finally(() => { if (this.chains.get(threadId) === next) this.chains.delete(threadId) })
    return next
  }

  private async write(input: ActivityInput, detail?: string, current: () => boolean = () => !this.deleted.has(input.threadId)): Promise<void> {
    if (!current()) return
    if (detail !== undefined) {
      await this.store.setDetail(input.threadId, input.id, detail, false, input.kind === 'command', current)
      if (!current()) return
      input.hasDetail = Boolean(detail)
      if (!input.summary) input.summary = redactActivityText(detail).slice(0, 240)
    } else {
      const existing = await this.store.lookup(input.threadId, input.id)
      if (!current()) return
      if (existing?.hasDetail) input.hasDetail = true
    }
    if (current()) await this.store.append(input, current)
  }

  private invalidateRecovery(threadId: string): void {
    this.recoveryEpochs.set(threadId, (this.recoveryEpochs.get(threadId) ?? 0) + 1)
    this.recovering.delete(threadId)
  }

  private tombstone(threadId: string): void {
    this.deleted.add(threadId)
    this.invalidateRecovery(threadId)
    for (const [key, pending] of this.pending) if (pending.input.threadId === threadId) this.pending.delete(key)
    this.pendingSubmissions.delete(threadId)
  }

  async beforeRpc(method: string, params: unknown): Promise<string | null> {
    const payload = record(params)
    const threadId = text(payload.threadId)
    if (threadId && method === 'thread/goal/get') {
      const id = 'goal-read:' + randomUUID()
      this.requestGoalRevisions.set(id, this.goalRevisions.get(threadId) ?? 0)
      return id
    }
    if (!threadId || !['turn/start', 'turn/steer', 'turn/interrupt', 'thread/goal/set'].includes(method)) return null
    const id = (method === 'turn/interrupt' ? 'interrupt:' : 'submission:') + randomUUID()
    if (method === 'thread/goal/set') {
      this.requestGoalRevisions.set(id, this.goalRevisions.get(threadId) ?? 0)
      await this.run(threadId, () => this.write(this.input(threadId, id, 'goal', payload.objective ? 'Goal submitted' : 'Goal change requested', 'pending'), text(payload.objective) || `Status: ${text(payload.status)}`))
    } else if (method === 'turn/interrupt') {
      await this.run(threadId, () => this.write({ ...this.input(threadId, id, 'interruption', 'Stop requested', 'pending'), turnId: text(payload.turnId) || null }))
    } else {
      const input = Array.isArray(payload.input) ? payload.input : []
      const detail = input.map(part => record(part).type === 'text' ? text(record(part).text) : `[${text(record(part).type) || 'attachment'}]`).join('\n')
      this.pendingSubmissions.set(threadId, id)
      await this.run(threadId, () => this.write(this.input(threadId, id, 'prompt', 'Prompt submitted', 'pending'), detail))
    }
    return id
  }

  async afterRpc(method: string, params: unknown, result: unknown, submission: string | null): Promise<void> {
    const payload = record(params)
    const threadId = text(payload.threadId)
    if (!threadId) return
    if (method === 'thread/delete') {
      this.tombstone(threadId)
      await this.chains.get(threadId)
      await this.store.remove(threadId).catch(() => this.store.reportFailure(threadId))
      return
    }
    if (this.deleted.has(threadId)) return
    if (method === 'thread/goal/set' || method === 'thread/goal/get') {
      const revision = submission ? this.requestGoalRevisions.get(submission) : undefined
      if (submission) this.requestGoalRevisions.delete(submission)
      if ((revision === undefined || revision === (this.goalRevisions.get(threadId) ?? 0)) && record(result).goal) await this.goal(threadId, record(record(result).goal), method === 'thread/goal/get')
      if (method === 'thread/goal/get' && record(result).goal === null && this.lastGoals.has(threadId) && (revision === undefined || revision === (this.goalRevisions.get(threadId) ?? 0))) this.notification({ method: 'thread/goal/cleared', params: { threadId } })
      if (method === 'thread/goal/get') return
    } else if (method === 'thread/goal/clear' && record(result).cleared === true) {
      this.notification({ method: 'thread/goal/cleared', params: { threadId } })
    }
    if (!submission) return
    const turnId = text(record(record(result).turn).id) || text(payload.turnId) || null
    if (turnId) this.submittedTurns.set(threadId + ':' + turnId, submission)
    if (this.submittedTurns.size > 256) this.submittedTurns.delete(this.submittedTurns.keys().next().value!)
    if (this.pendingSubmissions.get(threadId) === submission) this.pendingSubmissions.delete(threadId)
    await this.run(threadId, async () => {
      const existing = await this.store.lookup(threadId, submission)
      if (existing) await this.store.append({ ...existing, turnId, status: 'completed', summary: existing.summary || 'Accepted by Codex', updatedAt: new Date().toISOString() })
    })
  }

  async rpcFailed(params: unknown, submission: string | null, failure: unknown): Promise<void> {
    const threadId = text(record(params).threadId)
    if (!threadId || !submission) return
    this.requestGoalRevisions.delete(submission)
    if (submission.startsWith('goal-read:')) return
    if (this.pendingSubmissions.get(threadId) === submission) this.pendingSubmissions.delete(threadId)
    await this.run(threadId, async () => {
      const existing = await this.store.lookup(threadId, submission)
      if (existing) await this.write({ ...existing, status: 'failed', summary: failure instanceof Error ? failure.message : 'Submission failed' })
    })
  }

  recordQueue(previous: RecordValue, next: RecordValue): void {
    for (const threadId of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const before = new Map((Array.isArray(previous[threadId]) ? previous[threadId] : []).map(message => [text(record(message).id), record(message)]))
      const after = new Map((Array.isArray(next[threadId]) ? next[threadId] : []).map(message => [text(record(message).id), record(message)]))
      for (const [id, message] of after) {
        if (before.has(id)) continue
        void this.run(threadId, () => this.write(this.input(threadId, 'queue:' + id, 'queue', 'Prompt queued', 'pending'), text(message.text)))
      }
      for (const id of before.keys()) {
        if (after.has(id)) continue
        void this.run(threadId, async () => {
          const existing = await this.store.lookup(threadId, 'queue:' + id)
          if (existing) await this.store.append({ ...existing, status: 'completed', summary: 'Left the queue; see following actions for dispatch or removal.', updatedAt: new Date().toISOString() })
        })
      }
    }
  }

  private goal(threadId: string, goal: RecordValue, observed = false): Promise<void> {
    this.clearedGoals.delete(threadId)
    const createdAt = typeof goal.createdAt === 'number' ? goal.createdAt : 0
    const updatedAt = typeof goal.updatedAt === 'number' ? goal.updatedAt : 0
    const status = text(goal.status)
    const identity = `goal:${createdAt}:${createHash('sha256').update(text(goal.objective)).digest('hex').slice(0, 12)}`
    const previous = this.lastGoals.get(threadId)
    this.lastGoals.set(threadId, { status, updatedAt, createdAt, identity })
    return this.run(threadId, async () => {
      const id = identity
      const entry = { ...this.input(threadId, id, 'goal', 'Goal usage', status === 'complete' ? 'completed' : status === 'active' ? 'running' : status === 'paused' ? 'paused' : 'blocked'), goalCreatedAt: createdAt, startedAt: timestamp(createdAt), summary: `Status: ${status} · ${Number(goal.tokensUsed) || 0} tokens · ${Number(goal.timeUsedSeconds) || 0}s reported work · budget ${goal.tokenBudget ?? 'Unlimited'}`, hasDetail: true }
      await this.store.setDetail(threadId, id, text(goal.objective))
      await this.store.append(entry)
      if (!previous || previous.status !== status || previous.identity !== identity) {
        await this.write({ ...entry, id: `${id}:${status}:${updatedAt}`, title: observed ? `Goal observed: ${status}` : `Goal ${status}`, status: 'completed', summary: text(goal.objective), startedAt: observed ? new Date().toISOString() : timestamp(updatedAt), hasDetail: true }, text(goal.objective))
      }
    })
  }

  notification(notification: { method: string; params: unknown }): void {
    const params = record(notification.params)
    const nested = record(params.params)
    const threadId = text(params.threadId) || text(nested.threadId) || text(record(params.thread).id)
    if (!threadId) return
    const method = notification.method
    const turn = record(params.turn)
    const turnId = text(params.turnId) || text(turn.id) || null
    if (method === 'thread/deleted') {
      this.tombstone(threadId)
      void (this.chains.get(threadId) ?? Promise.resolve()).then(() => this.store.remove(threadId)).catch(() => this.store.reportFailure(threadId))
      return
    }
    if (this.deleted.has(threadId)) return
    if (method === 'thread/closed') { this.invalidateRecovery(threadId); return }
    if (method === 'thread/goal/updated') {
      this.goalRevisions.set(threadId, (this.goalRevisions.get(threadId) ?? 0) + 1)
      void this.goal(threadId, record(params.goal))
      return
    }
    if (method === 'thread/goal/cleared') {
      if (this.clearedGoals.has(threadId)) return
      this.clearedGoals.add(threadId)
      this.goalRevisions.set(threadId, (this.goalRevisions.get(threadId) ?? 0) + 1)
      const previous = this.lastGoals.get(threadId)
      this.lastGoals.delete(threadId)
      void this.run(threadId, async () => {
        if (previous) {
          const usage = await this.store.lookup(threadId, previous.identity)
          if (usage) await this.store.append({ ...usage, status: 'cleared', summary: usage.summary.replace(/Status:[^·]+/, 'Status: cleared '), updatedAt: new Date().toISOString() })
        }
        await this.write(this.input(threadId, 'goal-cleared:' + randomUUID(), 'goal', 'Goal cleared', 'completed'))
      })
      return
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const status: ActivityStatus = method === 'turn/started' ? 'running' : turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'interrupted' : 'completed'
      const input = { ...this.input(threadId, 'turn:' + turnId, 'turn', 'Turn', status), turnId, startedAt: timestamp(turn.startedAt), durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null, summary: text(record(turn.error).message) }
      void this.run(threadId, () => this.write(input))
      if (method === 'turn/completed') { void this.flush(threadId); this.submittedTurns.delete(threadId + ':' + turnId) }
      return
    }
    if (method === 'server/request' || method === 'server/request/resolved') {
      const key = threadId + ':' + params.id
      const requestTurn = text(nested.turnId) || turnId
      const identity = this.approvalEntries.get(key) ?? { id: `approval:${requestTurn ?? randomUUID()}:${params.id}`, turnId: requestTurn }
      if (method === 'server/request') this.approvalEntries.set(key, identity)
      else this.approvalEntries.delete(key)
      const input = { ...this.input(threadId, identity.id, 'approval', text(params.method).includes('Approval') ? 'Approval requested' : 'Input requested', method === 'server/request' ? 'pending' : 'completed'), turnId: identity.turnId, summary: method === 'server/request' ? 'Waiting for a response' : `Response submitted${params.decision ? ': ' + text(params.decision) : ''}` }
      void this.run(threadId, () => this.write(input, method === 'server/request' ? JSON.stringify(nested, null, 2) : undefined))
      return
    }
    if (method === 'turn/plan/updated') {
      void this.run(threadId, () => this.write({ ...this.input(threadId, 'plan:' + turnId, 'plan', 'Plan'), turnId }, JSON.stringify({ explanation: params.explanation, steps: params.plan }, null, 2)))
      return
    }
    if (method === 'error') {
      void this.run(threadId, () => this.write({ ...this.input(threadId, 'error:' + randomUUID(), 'error', 'Error', 'failed'), turnId }, text(record(params.error).message)))
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item)
      const type = text(item.type)
      const itemId = text(item.id)
      if (!type || !itemId || type === 'reasoning' && method === 'item/started') return
      if (type === 'userMessage') {
        const submission = this.pendingSubmissions.get(threadId) || this.submittedTurns.get(threadId + ':' + turnId)
        if (submission) {
          void this.run(threadId, async () => {
            const existing = await this.store.lookup(threadId, submission)
            if (!existing) return
            await this.store.append({ ...existing, turnId, itemId, updatedAt: new Date().toISOString() })
            await this.store.alias(threadId, 'item:' + itemId, submission)
          })
          return
        }
      }
      const status: ActivityStatus = method === 'item/started' ? 'running' : item.status === 'failed' || typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'failed' : 'completed'
      const input = { ...this.input(threadId, 'item:' + itemId, itemKind(type), itemTitle(type, item), status), turnId, itemId, durationMs: typeof item.durationMs === 'number' ? item.durationMs : null }
      const pending = this.pending.get(threadId + ':' + itemId)
      if (pending) { this.pending.delete(threadId + ':' + itemId); void this.flushEntry(pending) }
      void this.run(threadId, () => this.write(input, itemDetail(type, item) || undefined))
      return
    }
    const kinds: Record<string, ActivityKind> = { 'item/agentMessage/delta': 'message', 'item/commandExecution/outputDelta': 'command', 'item/plan/delta': 'plan', 'item/reasoning/summaryTextDelta': 'plan' }
    const kind = kinds[method]
    const itemId = text(params.itemId)
    const delta = text(params.delta)
    if (!kind || !itemId || !delta) return
    const key = threadId + ':' + itemId
    const pending = this.pending.get(key) ?? { input: { ...this.input(threadId, 'item:' + itemId, kind, method === 'item/reasoning/summaryTextDelta' ? 'Reasoning summary' : kind === 'command' ? 'Command output' : kind === 'message' ? 'Assistant update' : 'Plan'), turnId, itemId, hasDetail: true }, chunks: [] }
    pending.chunks.push(delta)
    this.pending.set(key, pending)
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 250)
      this.timer.unref?.()
    }
  }

  private flushEntry(pending: { input: ActivityInput; chunks: string[] }): Promise<void> {
    return this.run(pending.input.threadId, async () => {
      const existing = await this.store.lookup(pending.input.threadId, pending.input.id)
      await this.store.setDetail(pending.input.threadId, pending.input.id, pending.chunks.join(''), true)
      await this.store.append({ ...pending.input, ...existing, hasDetail: true, updatedAt: new Date().toISOString() })
    })
  }

  recover(threadId: string, rpc: RpcExecutor, more = false): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve()
    const existing = this.recovering.get(threadId)
    if (existing) return existing
    const epoch = this.recoveryEpochs.get(threadId) ?? 0
    // The native lease binds at guarded dispatch, not after a fulfilled read: a
    // replacement can already exist when this recorder's continuation resumes.
    const lease = rpc.createActivityRecoveryLease?.(threadId)
    const transport = rpc as RpcExecutor & { readonly process?: unknown }
    const hasNativeGeneration = 'process' in transport
    let nativeGeneration = transport.process
    const read = (method: string, params: unknown): Promise<unknown> => {
      if (lease) return lease.rpc(method, params)
      const pending = rpc.rpc(method, params)
      // Compatibility for isolated executors that start synchronously. Never
      // infer a cold generation from a process observed after an awaited result.
      if (!nativeGeneration) nativeGeneration = transport.process
      return pending
    }
    const current = () => !this.deleted.has(threadId) && epoch === (this.recoveryEpochs.get(threadId) ?? 0)
      && (lease ? lease.isCurrent() : !hasNativeGeneration || transport.process === nativeGeneration)
    const promise = (async () => {
      const page = await this.store.page(threadId, { limit: 1 })
      if (!current()) return
      if (page.coverage.recoveryComplete || page.coverage.recoveredHistory && !more) return
      const storedCursor = page.coverage.recoveryCursor
      const mode = storedCursor?.startsWith('turns:') ? 'turns' : 'items'
      const cursor = storedCursor ? storedCursor.slice(storedCursor.indexOf(':') + 1) : null
      let source = mode
      let result: RecordValue
      try {
        result = record(await read(mode === 'items' ? 'thread/items/list' : 'thread/turns/list', {
          threadId, limit: mode === 'items' ? 100 : 10, sortDirection: 'desc', ...(mode === 'turns' ? { itemsView: 'full' } : {}), ...(cursor ? { cursor } : {}),
        }))
      } catch (failure) {
        if (!current()) return
        if (mode !== 'items' || storedCursor || !/unsupported|method not found|unknown method|not supported/i.test(failure instanceof Error ? failure.message : '')) throw failure
        source = 'turns'
        result = record(await read('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'full' }))
      }
      if (!current()) return
      const rows = Array.isArray(result.data) ? result.data : []
      const entries = source === 'items'
        ? [...rows].reverse().map(value => ({ turnId: text(record(value).turnId), item: record(record(value).item), startedAt: null as string | null, status: 'completed' }))
        : [...rows].reverse().flatMap(value => {
          const turn = record(value)
          return (Array.isArray(turn.items) ? turn.items : []).map(item => ({ turnId: text(turn.id), item: record(item), startedAt: timestamp(turn.startedAt), status: text(turn.status) }))
        })
      const recoveryPage = (page.coverage.recoveryPages ?? 0) + 1
      for (const [index, value] of entries.entries()) {
        if (!current()) return
        const type = text(value.item.type)
        const itemId = text(value.item.id)
        if (!type || !itemId) continue
        const id = 'item:' + itemId
        const found = await this.store.lookup(threadId, id)
        if (!current()) return
        if (found) continue
        const failed = value.item.status === 'failed' || typeof value.item.exitCode === 'number' && value.item.exitCode !== 0
        const running = value.status === 'inProgress' || value.item.status === 'inProgress'
        const input = { ...this.input(threadId, id, itemKind(type), itemTitle(type, value.item), failed ? 'failed' : running ? 'running' : 'completed'), turnId: value.turnId, itemId, startedAt: value.startedAt, reconstructed: true, historyOrder: -recoveryPage * 1000000 + index }
        await this.run(threadId, () => this.write(input, itemDetail(type, value.item), current), current)
        if (!current()) return
      }
      const nextCursor = text(result.nextCursor) || null
      if (current()) await this.store.updateCoverage(threadId, { recoveredHistory: true, recoveryCursor: nextCursor ? source + ':' + nextCursor : null, recoveryComplete: nextCursor === null, recoveryPages: recoveryPage }, current)
    })().catch(async () => {
      if (!current()) return
      await this.store.updateCoverage(threadId, { warning: 'Older activity could not be recovered. Captured activity remains available.' }, current).catch(() => { if (current()) this.store.reportFailure(threadId) })
    }).finally(() => { if (this.recovering.get(threadId) === promise) this.recovering.delete(threadId) })
    this.recovering.set(threadId, promise)
    return promise
  }

  async flush(threadId?: string): Promise<void> {
    if (!threadId) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
    }
    const pending = [...this.pending.entries()].filter(([, value]) => !threadId || value.input.threadId === threadId)
    for (const [key] of pending) this.pending.delete(key)
    await Promise.all(pending.map(([, value]) => this.flushEntry(value)))
    await Promise.all(threadId ? [this.chains.get(threadId) ?? Promise.resolve()] : [...this.chains.values()])
    await this.store.flush(threadId)
  }
}
