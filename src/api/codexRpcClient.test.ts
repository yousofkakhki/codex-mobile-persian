import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeRpcNotifications } from './codexRpcClient'

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach(stop => stop())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('shared RPC notifications', () => {
  it('uses one connection and keeps it open until its final subscriber leaves', () => {
    vi.useFakeTimers()
    const sockets: Array<{ onmessage: ((event: { data: string }) => void) | null; onclose: (() => void) | null; close: () => void }> = []
    class Socket {
      onmessage = null
      onclose = null
      close = vi.fn()
      constructor() { sockets.push(this) }
    }
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' }, setTimeout, clearTimeout })
    vi.stubGlobal('WebSocket', Socket)
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = subscribeRpcNotifications(first)
    const stopSecond = subscribeRpcNotifications(second)
    cleanup.push(stopFirst, stopSecond)
    expect(sockets).toHaveLength(1)
    sockets[0].onmessage?.({ data: JSON.stringify({ method: 'thread/goal/updated', params: { threadId: 'a' }, atIso: '' }) })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    stopFirst()
    expect(sockets[0].close).not.toHaveBeenCalled()
    stopSecond()
    expect(sockets[0].close).toHaveBeenCalledTimes(1)
  })
})
