export type RpcConnectionState = 'offline' | 'connecting' | 'connected' | 'reconnecting'

export type RpcTelemetrySnapshot = {
  bytesSent: number
  bytesReceived: number
  uploadRateBytesPerSecond: number
  downloadRateBytesPerSecond: number
  transferRateBytesPerSecond: number
  activeRequests: number
  totalRequests: number
  completedRequests: number
  failedRequests: number
  notificationsReceived: number
  lastRequestLatencyMs: number | null
  connectionState: RpcConnectionState
  lastActivityAtMs: number | null
}

type TransferSample = {
  atMs: number
  sent: number
  received: number
}

type RpcRequestResult = {
  bytesReceived?: number
  latencyMs?: number
  failed?: boolean
}

const TRANSFER_WINDOW_MS = 5000

const transferSamples: TransferSample[] = []
const listeners = new Set<(snapshot: RpcTelemetrySnapshot) => void>()

let bytesSent = 0
let bytesReceived = 0
let activeRequests = 0
let totalRequests = 0
let completedRequests = 0
let failedRequests = 0
let notificationsReceived = 0
let lastRequestLatencyMs: number | null = null
let connectionState: RpcConnectionState = 'offline'
let lastActivityAtMs: number | null = null

function pruneSamples(nowMs: number): void {
  const cutoff = nowMs - TRANSFER_WINDOW_MS
  while (transferSamples.length > 0 && transferSamples[0].atMs < cutoff) {
    transferSamples.shift()
  }
}

function addTransferSample(sent: number, received: number, nowMs = Date.now()): void {
  const normalizedSent = Number.isFinite(sent) && sent > 0 ? sent : 0
  const normalizedReceived = Number.isFinite(received) && received > 0 ? received : 0
  if (normalizedSent > 0 || normalizedReceived > 0) {
    transferSamples.push({ atMs: nowMs, sent: normalizedSent, received: normalizedReceived })
  }
  lastActivityAtMs = nowMs
  pruneSamples(nowMs)
}

function buildSnapshot(nowMs = Date.now()): RpcTelemetrySnapshot {
  pruneSamples(nowMs)

  let windowSent = 0
  let windowReceived = 0
  for (const sample of transferSamples) {
    windowSent += sample.sent
    windowReceived += sample.received
  }

  const firstSampleAtMs = transferSamples[0]?.atMs ?? nowMs
  const elapsedMs = Math.max(1000, Math.min(TRANSFER_WINDOW_MS, nowMs - firstSampleAtMs))
  const uploadRateBytesPerSecond = windowSent / (elapsedMs / 1000)
  const downloadRateBytesPerSecond = windowReceived / (elapsedMs / 1000)

  return {
    bytesSent,
    bytesReceived,
    uploadRateBytesPerSecond,
    downloadRateBytesPerSecond,
    transferRateBytesPerSecond: uploadRateBytesPerSecond + downloadRateBytesPerSecond,
    activeRequests,
    totalRequests,
    completedRequests,
    failedRequests,
    notificationsReceived,
    lastRequestLatencyMs,
    connectionState,
    lastActivityAtMs,
  }
}

function publish(nowMs = Date.now()): void {
  const snapshot = buildSnapshot(nowMs)
  for (const listener of listeners) listener(snapshot)
}

export function byteLength(value: string): number {
  if (!value) return 0
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength
  if (typeof Blob !== 'undefined') return new Blob([value]).size
  return value.length
}

export function getRpcTelemetrySnapshot(): RpcTelemetrySnapshot {
  return buildSnapshot()
}

export function subscribeRpcTelemetry(listener: (snapshot: RpcTelemetrySnapshot) => void): () => void {
  listeners.add(listener)
  listener(getRpcTelemetrySnapshot())
  return () => listeners.delete(listener)
}

export function recordRpcRequestStarted(requestBytes: number): void {
  activeRequests += 1
  totalRequests += 1
  bytesSent += Math.max(0, requestBytes)
  addTransferSample(requestBytes, 0)
  publish()
}

export function recordRpcRequestFinished(result: RpcRequestResult = {}): void {
  activeRequests = Math.max(0, activeRequests - 1)
  if (result.failed) failedRequests += 1
  else completedRequests += 1
  const received = Math.max(0, result.bytesReceived ?? 0)
  bytesReceived += received
  if (typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs)) {
    lastRequestLatencyMs = Math.max(0, result.latencyMs)
  }
  addTransferSample(0, received)
  publish()
}

export function recordRpcStreamBytes(receivedBytes: number): void {
  const normalized = Math.max(0, receivedBytes)
  bytesReceived += normalized
  addTransferSample(0, normalized)
  publish()
}

export function recordRpcNotification(): void {
  notificationsReceived += 1
  lastActivityAtMs = Date.now()
  publish()
}

export function setRpcConnectionState(nextState: RpcConnectionState): void {
  if (connectionState === nextState) return
  connectionState = nextState
  lastActivityAtMs = Date.now()
  publish()
}
