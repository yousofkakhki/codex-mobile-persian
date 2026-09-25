import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramThreadBridge } from './telegramThreadBridge'

type Notification = { method: string; params: unknown }

function createAppServer(thread: Record<string, unknown>) {
  let listener: ((notification: Notification) => void) | null = null
  const appServer = {
    rpc: vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread }
      throw new Error(`Unexpected RPC: ${method}`)
    }),
    onNotification: vi.fn((next: (notification: Notification) => void) => {
      listener = next
      return () => {
        if (listener === next) listener = null
      }
    }),
    emit(notification: Notification): void {
      listener?.(notification)
    },
  }
  return appServer
}

function telegramApiResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Telegram completion notifications', () => {
  it('notifies configured chats once when a turn completes without a mapped Telegram thread', async () => {
    const appServer = createAppServer({
      name: 'MAX reasoning thread',
      model: 'gpt-5.6-luna',
      turns: [{
        items: [{ type: 'agentMessage', text: 'The long-running task is complete.' }],
      }],
    })
    const sendRequests: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: unknown, init?: { body?: BodyInit | null }) => {
      const url = String(input)
      const method = url.split('/').at(-1)
      if (method === 'getUpdates') {
        return await new Promise<Response>(() => {})
      }
      if (method === 'sendMessage') {
        sendRequests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      }
      return telegramApiResponse({ ok: true, result: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const bridge = new TelegramThreadBridge(appServer)
    bridge.configureToken('123:test-token')
    bridge.configureNotificationChatIds([111, 222])
    bridge.start()

    appServer.emit({ method: 'turn/started', params: { threadId: 'thread-1', turnId: 'turn-1' } })
    const completion = {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    }
    appServer.emit(completion)
    appServer.emit(completion)

    await vi.waitFor(() => expect(sendRequests).toHaveLength(2))
    expect(sendRequests.map((request) => request.chat_id)).toEqual(expect.arrayContaining([111, 222]))
    expect(sendRequests[0]?.text).toEqual(expect.stringContaining('اجرای ترد Codex تمام شد'))
    expect(sendRequests[0]?.text).toEqual(expect.stringContaining('thread-1'))
    expect(sendRequests[0]?.text).toEqual(expect.stringContaining('MAX reasoning thread'))
    expect(sendRequests[0]?.text).toEqual(expect.stringContaining('gpt-5.6-luna'))
    expect(sendRequests[0]?.text).toEqual(expect.stringContaining('The long-running task is complete.'))
    expect(bridge.getStatus().notificationChats).toBe(2)

    bridge.stop()
  })

  it('sends a failure notification when the completed turn has no assistant message', async () => {
    const appServer = createAppServer({ name: 'Failed thread', turns: [] })
    const sendRequests: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: unknown, init?: { body?: BodyInit | null }) => {
      const url = String(input)
      const method = url.split('/').at(-1)
      if (method === 'getUpdates') return await new Promise<Response>(() => {})
      if (method === 'sendMessage') {
        sendRequests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      }
      return telegramApiResponse({ ok: true, result: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const bridge = new TelegramThreadBridge(appServer)
    bridge.configureToken('123:test-token')
    bridge.configureNotificationChatIds([333])
    bridge.start()
    appServer.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-failed',
        turnId: 'turn-failed',
        turn: { id: 'turn-failed', status: 'failed', error: { message: 'Provider timed out' } },
      },
    })

    await vi.waitFor(() => expect(sendRequests).toHaveLength(1))
    expect(sendRequests[0]?.text).toEqual(expect.stringContaining('اجرای ترد Codex ناموفق بود'))
    expect(sendRequests[0]?.text).toEqual(expect.stringContaining('Provider timed out'))
    bridge.stop()
  })
})
