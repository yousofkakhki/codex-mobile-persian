import type { RpcEnvelope, RpcMethodCatalog } from '../types/codex'
import { CodexApiError, extractErrorMessage } from './codexErrors'
import {
  byteLength,
  recordRpcNotification,
  recordRpcRequestFinished,
  recordRpcRequestStarted,
  recordRpcStreamBytes,
  setRpcConnectionState,
} from './codexRpcTelemetry'

type RpcRequestBody = {
  method: string
  params?: unknown
}

export type RpcNotification = {
  method: string
  params: unknown
  atIso: string
}

type ServerRequestReplyBody = {
  id: number
  result?: unknown
  error?: {
    code?: number
    message: string
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const body: RpcRequestBody = { method, params: params ?? null }
  const requestBody = JSON.stringify(body)
  const startedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
  let responseBytes = 0
  let telemetryFinished = false

  const finishTelemetry = (failed: boolean): void => {
    if (telemetryFinished) return
    telemetryFinished = true
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
    recordRpcRequestFinished({
      bytesReceived: responseBytes,
      latencyMs: Math.max(0, nowMs - startedAtMs),
      failed,
    })
  }

  recordRpcRequestStarted(byteLength(requestBody))

  try {
    const response = await fetch('/codex-api/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestBody,
    })

    let payload: unknown = null
    let rawText: string | null = null
    try {
      rawText = await response.text()
      responseBytes = byteLength(rawText)
      payload = JSON.parse(rawText)
    } catch {
      payload = null
    }

    if (!response.ok) {
      finishTelemetry(true)
      const detail = extractErrorMessage(payload, '') || rawText?.slice(0, 500) || ''
      const prefix = `RPC ${method} failed with HTTP ${response.status}`
      throw new CodexApiError(
        detail ? `${prefix}: ${detail}` : prefix,
        {
          code: 'http_error',
          method,
          status: response.status,
        },
      )
    }

    const envelope = payload as RpcEnvelope<T> | null
    if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) {
      finishTelemetry(true)
      throw new CodexApiError(`RPC ${method} returned malformed envelope`, {
        code: 'invalid_response',
        method,
        status: response.status,
      })
    }

    finishTelemetry(false)
    return envelope.result
  } catch (error) {
    finishTelemetry(true)
    if (error instanceof CodexApiError) throw error
    throw new CodexApiError(
      error instanceof Error ? error.message : `RPC ${method} failed before request was sent`,
      { code: 'network_error', method },
    )
  }
}

export async function fetchRpcMethodCatalog(): Promise<string[]> {
  const response = await fetch('/codex-api/meta/methods')

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Method catalog failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'meta/methods',
        status: response.status,
      },
    )
  }

  const catalog = payload as RpcMethodCatalog
  return Array.isArray(catalog.data) ? catalog.data : []
}

export async function fetchRpcNotificationCatalog(): Promise<string[]> {
  const response = await fetch('/codex-api/meta/notifications')

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Notification catalog failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'meta/notifications',
        status: response.status,
      },
    )
  }

  const catalog = payload as RpcMethodCatalog
  return Array.isArray(catalog.data) ? catalog.data : []
}

function toNotification(value: unknown): RpcNotification | null {
  const record = asRecord(value)
  if (!record) return null
  if (typeof record.method !== 'string' || record.method.length === 0) return null

  const atIso = typeof record.atIso === 'string' && record.atIso.length > 0
    ? record.atIso
    : new Date().toISOString()

  return {
    method: record.method,
    params: record.params ?? null,
    atIso,
  }
}

function emitReadyNotification(
  onNotification: (value: RpcNotification) => void,
  params: unknown = { ok: true },
): void {
  onNotification({
    method: 'ready',
    params,
    atIso: new Date().toISOString(),
  })
}

function openRpcNotificationStream(onNotification: (value: RpcNotification) => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  let cleanup: (() => void) | null = null
  let closed = false
  let reconnectTimer: number | null = null

  const clearReconnectTimer = () => {
    if (reconnectTimer === null) return
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const scheduleReconnect = (attach: () => void, attempt: number) => {
    if (closed || reconnectTimer !== null) return
    const delayMs = Math.min(1000 * (2 ** attempt), 10000)
    setRpcConnectionState('reconnecting')
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (closed) return
      attach()
    }, delayMs)
  }

  const handleNotificationPayload = (payload: unknown): void => {
    const notification = toNotification(payload)
    if (notification) {
      onNotification(notification)
    }
  }

  const handleNotificationText = (rawText: string): void => {
    recordRpcStreamBytes(byteLength(rawText))
    recordRpcNotification()
    try {
      handleNotificationPayload(JSON.parse(rawText) as unknown)
    } catch {
      // Ignore malformed event payloads and keep stream alive.
    }
  }

  const attachSse = (attempt = 0) => {
    if (typeof EventSource === 'undefined' || closed) return
    cleanup?.()
    setRpcConnectionState(attempt > 0 ? 'reconnecting' : 'connecting')
    const source = new EventSource('/codex-api/events')
    let isConnectionClosed = false

    source.onmessage = (event) => {
      handleNotificationText(String(event.data ?? ''))
    }

    source.addEventListener('ready', (event: MessageEvent<string>) => {
      const rawText = event.data ?? ''
      recordRpcStreamBytes(byteLength(rawText))
      recordRpcNotification()
      setRpcConnectionState('connected')
      try {
        const parsed = rawText ? JSON.parse(rawText) as unknown : { ok: true }
        emitReadyNotification(onNotification, parsed)
      } catch {
        emitReadyNotification(onNotification)
      }
    })

    source.onerror = () => {
      if (closed || isConnectionClosed) return
      if (source.readyState === EventSource.CLOSED) {
        isConnectionClosed = true
        source.close()
        scheduleReconnect(() => attachSse(attempt + 1), attempt)
      }
    }

    cleanup = () => {
      isConnectionClosed = true
      source.close()
    }
  }

  const attachWebSocket = (attempt = 0) => {
    if (typeof WebSocket === 'undefined' || closed) {
      attachSse()
      return
    }

    cleanup?.()
    setRpcConnectionState(attempt > 0 ? 'reconnecting' : 'connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/codex-api/ws`)
    let didOpen = false
    let intentionallyClosed = false
    let fallbackTimer: number | null = window.setTimeout(() => {
      if (didOpen || closed || intentionallyClosed) return
      intentionallyClosed = true
      socket.close()
      attachSse()
    }, 2500)

    socket.onopen = () => {
      didOpen = true
      setRpcConnectionState('connected')
      clearReconnectTimer()
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
    }

    socket.onmessage = (event) => {
      handleNotificationText(typeof event.data === 'string' ? event.data : String(event.data))
    }

    socket.onerror = () => {
      // Wait for close so we do not race duplicate reconnect/fallback paths.
    }

    socket.onclose = () => {
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      if (closed || intentionallyClosed) {
        return
      }
      if (!didOpen) {
        attachSse()
        return
      }
      scheduleReconnect(() => attachWebSocket(attempt + 1), attempt)
    }

    cleanup = () => {
      intentionallyClosed = true
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      socket.close()
    }
  }

  setRpcConnectionState('connecting')
  if (typeof WebSocket !== 'undefined') {
    attachWebSocket()
  } else {
    attachSse()
  }

  return () => {
    closed = true
    clearReconnectTimer()
    cleanup?.()
    setRpcConnectionState('offline')
  }
}

const notificationSubscribers = new Set<(value: RpcNotification) => void>()
let stopSharedNotificationStream: (() => void) | null = null

export function publishLocalRpcNotification(notification: RpcNotification): void {
  for (const subscriber of notificationSubscribers) {
    try {
      subscriber(notification)
    } catch {}
  }
}

export function subscribeRpcNotifications(onNotification: (value: RpcNotification) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const subscriber = (notification: RpcNotification) => onNotification(notification)
  notificationSubscribers.add(subscriber)
  if (!stopSharedNotificationStream) {
    stopSharedNotificationStream = openRpcNotificationStream(publishLocalRpcNotification)
  }
  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    notificationSubscribers.delete(subscriber)
    if (notificationSubscribers.size === 0) {
      stopSharedNotificationStream?.()
      stopSharedNotificationStream = null
    }
  }
}

export async function respondServerRequest(body: ServerRequestReplyBody): Promise<void> {
  let response: Response
  try {
    response = await fetch('/codex-api/server-requests/respond', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new CodexApiError(
      error instanceof Error ? error.message : 'Failed to reply to server request',
      { code: 'network_error', method: 'server-requests/respond' },
    )
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Server request reply failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'server-requests/respond',
        status: response.status,
      },
    )
  }
}

export async function fetchPendingServerRequests(): Promise<unknown[]> {
  const response = await fetch('/codex-api/server-requests/pending')

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `Pending server requests failed with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: 'server-requests/pending',
        status: response.status,
      },
    )
  }

  const record = asRecord(payload)
  const data = record?.data
  return Array.isArray(data) ? data : []
}
