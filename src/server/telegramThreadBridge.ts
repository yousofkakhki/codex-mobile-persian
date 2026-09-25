import { basename } from 'node:path'

type TelegramUpdate = {
  update_id?: number
  message?: {
    message_id?: number
    text?: string
    from?: {
      id?: number
    }
    chat?: {
      id?: number
    }
  }
  callback_query?: {
    id?: string
    data?: string
    from?: {
      id?: number
    }
    message?: {
      chat?: {
        id?: number
      }
    }
  }
}

type AppServerLike = {
  rpc: (method: string, params: unknown) => Promise<unknown>
  onNotification: (listener: (value: { method: string; params: unknown }) => void) => () => void
}

type TelegramThreadBridgeOptions = {
  onChatSeen?: (chatId: number) => void
}

export type TelegramBridgeStatus = {
  configured: boolean
  active: boolean
  mappedChats: number
  mappedThreads: number
  notificationChats: number
  allowedUsers: number
  allowAllUsers: boolean
  lastError: string
}

type TelegramBotCommand = {
  command: string
  description: string
}

type TelegramLanguage = 'en' | 'fa'

const TELEGRAM_MESSAGE_MAX_LENGTH = 3500
const TELEGRAM_BOT_COMMANDS_EN: TelegramBotCommand[] = [
  { command: 'start', description: 'Show quick start and thread picker' },
  { command: 'threads', description: 'List recent threads to connect' },
  { command: 'newthread', description: 'Create and connect a new thread' },
  { command: 'thread', description: 'Connect existing thread: /thread <id>' },
  { command: 'current', description: 'Show currently connected thread' },
  { command: 'history', description: 'Show recent history for current thread' },
  { command: 'status', description: 'Show bridge and mapping status' },
  { command: 'whoami', description: 'Show your Telegram IDs' },
  { command: 'language', description: 'Change language: /language fa|en' },
  { command: 'help', description: 'Show available commands' },
]

const TELEGRAM_BOT_COMMANDS_FA: TelegramBotCommand[] = [
  { command: 'start', description: 'نمایش راهنمای شروع و انتخاب ترد' },
  { command: 'threads', description: 'نمایش تردهای اخیر برای اتصال' },
  { command: 'newthread', description: 'ساخت ترد جدید و اتصال به آن' },
  { command: 'thread', description: 'اتصال به ترد موجود: /thread <id>' },
  { command: 'current', description: 'نمایش ترد متصل فعلی' },
  { command: 'history', description: 'نمایش تاریخچه اخیر ترد فعلی' },
  { command: 'status', description: 'نمایش وضعیت پل و اتصال‌ها' },
  { command: 'whoami', description: 'نمایش شناسه‌های تلگرام شما' },
  { command: 'language', description: 'تغییر زبان: /language fa|en' },
  { command: 'help', description: 'نمایش فرمان‌های موجود' },
]

const TELEGRAM_TEXT = {
  en: {
    online: 'Codex thread bridge went online.',
    noThreads: 'No threads found. Send /newthread to create one.',
    selectThread: 'Select a thread to connect:',
    noCurrentThread: 'No thread is connected for this chat yet. Use /threads, /newthread, or /thread <id>.',
    noCurrentThreadShort: 'No thread is connected for this chat yet. Use /threads or /newthread first.',
    invalidSelection: 'Invalid selection',
    invalidThreadId: 'Invalid thread id',
    threadConnected: 'Thread connected',
    historyEmpty: 'Thread has no message history yet.',
    recentHistory: 'Recent history:',
    userLabel: 'User',
    assistantLabel: 'Assistant',
    identity: 'Identity',
    telegramUserId: 'telegram user id',
    chatId: 'chat id',
    authorized: 'authorized',
    allowlistAll: 'allowlist mode: `*`',
    allowlistExplicit: 'allowlist mode: explicit ids',
    bridgeStatus: 'Bridge status',
    configured: 'configured',
    active: 'active',
    mappedChats: 'mapped chats',
    mappedThreads: 'mapped threads',
    allowedUsers: 'allowed users',
    allowAllUsers: 'allow all users',
    threadForChat: 'chat {chatId} thread',
    lastError: 'last error',
    forwardFailed: 'Forward failed',
    languageCurrent: 'Current bot language',
    languageUsage: 'Use /language fa or /language en to change it.',
    languageUnknown: 'Unknown language. Use /language fa or /language en.',
    languageSet: 'Bot language set to English.',
  },
  fa: {
    online: 'پل ارتباطی تردهای Codex فعال شد.',
    noThreads: 'تردی پیدا نشد. برای ساخت ترد جدید /newthread را بفرستید.',
    selectThread: 'یک ترد را برای اتصال انتخاب کنید:',
    noCurrentThread: 'هنوز تردی به این گفت‌وگو متصل نیست. از /threads، /newthread یا /thread <id> استفاده کنید.',
    noCurrentThreadShort: 'هنوز تردی به این گفت‌وگو متصل نیست. ابتدا /threads یا /newthread را بفرستید.',
    invalidSelection: 'انتخاب نامعتبر است',
    invalidThreadId: 'شناسه ترد نامعتبر است',
    threadConnected: 'ترد متصل شد',
    historyEmpty: 'این ترد هنوز تاریخچه‌ای ندارد.',
    recentHistory: 'تاریخچه اخیر:',
    userLabel: 'کاربر',
    assistantLabel: 'دستیار',
    identity: 'شناسه',
    telegramUserId: 'شناسه کاربر تلگرام',
    chatId: 'شناسه گفت‌وگو',
    authorized: 'مجاز',
    allowlistAll: 'حالت فهرست مجاز: `*`',
    allowlistExplicit: 'حالت فهرست مجاز: شناسه‌های مشخص',
    bridgeStatus: 'وضعیت پل ارتباطی',
    configured: 'پیکربندی شده',
    active: 'فعال',
    mappedChats: 'گفت‌وگوهای متصل',
    mappedThreads: 'تردهای متصل',
    allowedUsers: 'کاربران مجاز',
    allowAllUsers: 'اجازه برای همه کاربران',
    threadForChat: 'ترد گفت‌وگوی {chatId}',
    lastError: 'آخرین خطا',
    forwardFailed: 'ارسال پیام ناموفق بود',
    languageCurrent: 'زبان فعلی ربات',
    languageUsage: 'برای تغییر زبان از /language fa یا /language en استفاده کنید.',
    languageUnknown: 'زبان ناشناخته است. از /language fa یا /language en استفاده کنید.',
    languageSet: 'زبان ربات روی فارسی تنظیم شد.',
  },
} as const

type TelegramTextKey = keyof typeof TELEGRAM_TEXT.en

function telegramText(language: TelegramLanguage, key: TelegramTextKey): string {
  return TELEGRAM_TEXT[language][key]
}

function normalizeTelegramLanguage(value: unknown): TelegramLanguage | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['fa', 'fa-ir', 'farsi', 'persian', 'فارسی'].includes(normalized)) return 'fa'
  if (['en', 'en-us', 'english'].includes(normalized)) return 'en'
  return null
}

const DEFAULT_TELEGRAM_LANGUAGE = normalizeTelegramLanguage(process.env.TELEGRAM_DEFAULT_LANGUAGE) ?? 'fa'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }

  const record = asRecord(payload)
  if (!record) return fallback

  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error

  const nestedError = asRecord(error)
  if (nestedError && typeof nestedError.message === 'string' && nestedError.message.length > 0) {
    return nestedError.message
  }

  return fallback
}

type NormalizedTelegramAllowlist = {
  allowAllUsers: boolean
  allowedUserIds: number[]
}

function normalizeTelegramAllowlist(values: unknown): NormalizedTelegramAllowlist {
  const rawValues = Array.isArray(values) ? values : []
  const allowAllUsers = rawValues.some((value) => typeof value === 'string' && value.trim() === '*')
  const allowedUserIds = Array.from(new Set(rawValues
    .map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value)
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const normalized = value.trim().replace(/^(telegram|tg):/i, '').trim()
        if (/^-?\d+$/.test(normalized)) {
          return Number.parseInt(normalized, 10)
        }
      }
      return Number.NaN
    })
    .filter((value) => Number.isFinite(value)))).slice(0, 100)
  return { allowAllUsers, allowedUserIds }
}

function normalizeTelegramChatIds(values: unknown): number[] {
  const rawValues = Array.isArray(values) ? values : []
  return Array.from(new Set(rawValues
    .map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
      if (typeof value === 'string' && value.trim().length > 0) {
        const normalized = value.trim().replace(/^(telegram|tg):/i, '').trim()
        if (/^-?\d+$/.test(normalized)) return Number.parseInt(normalized, 10)
      }
      return Number.NaN
    })
    .filter((value) => Number.isFinite(value)))).slice(0, 50)
}

function formatTelegramDuration(durationMs: number | null, language: TelegramLanguage): string {
  if (durationMs === null || !Number.isFinite(durationMs)) {
    return language === 'fa' ? 'نامشخص' : 'unknown'
  }
  const normalized = Math.max(0, Math.round(durationMs))
  if (normalized < 1000) return language === 'fa'
    ? `${normalized} میلی‌ثانیه`
    : `${normalized} ms`
  const totalSeconds = Math.round(normalized / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return language === 'fa'
    ? `${seconds} ثانیه`
    : `${seconds}s`
  return language === 'fa'
    ? `${minutes} دقیقه و ${String(seconds).padStart(2, '0')} ثانیه`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function translateTelegramStatus(status: string, language: TelegramLanguage): string {
  if (language === 'en') return status
  const labels: Record<string, string> = {
    completed: 'با موفقیت تکمیل شد',
    failed: 'ناموفق بود',
    interrupted: 'متوقف شد',
    cancelled: 'لغو شد',
    canceled: 'لغو شد',
  }
  return labels[status.toLowerCase()] ?? status
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderMarkdownInlineToTelegramHtml(value: string): string {
  let rendered = escapeHtml(value)
  rendered = rendered.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  rendered = rendered.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  rendered = rendered.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<b>$1</b>')
  rendered = rendered.replace(/__([^_\n][^_\n]*?)__/g, '<b>$1</b>')
  rendered = rendered.replace(/\*([^*\n][^*\n]*?)\*/g, '<i>$1</i>')
  rendered = rendered.replace(/_([^_\n][^_\n]*?)_/g, '<i>$1</i>')
  rendered = rendered.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content: string) => `<b>${content}</b>`)
  return rendered
}

function renderMarkdownToTelegramHtml(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n')
  const fencedCodeRegex = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g
  let cursor = 0
  const parts: string[] = []
  let match = fencedCodeRegex.exec(normalized)

  while (match) {
    const [fullMatch, lang, code] = match
    const matchIndex = match.index
    const before = normalized.slice(cursor, matchIndex)
    if (before) {
      parts.push(renderMarkdownInlineToTelegramHtml(before))
    }

    const escapedCode = escapeHtml((code ?? '').replace(/\n+$/g, ''))
    const escapedLang = typeof lang === 'string' ? escapeHtml(lang) : ''
    if (escapedLang) {
      parts.push(`<pre><code class="language-${escapedLang}">${escapedCode}</code></pre>`)
    } else {
      parts.push(`<pre>${escapedCode}</pre>`)
    }

    cursor = matchIndex + fullMatch.length
    match = fencedCodeRegex.exec(normalized)
  }

  const tail = normalized.slice(cursor)
  if (tail) {
    parts.push(renderMarkdownInlineToTelegramHtml(tail))
  }

  return parts.join('')
}

function splitTelegramText(text: string, maxLength = TELEGRAM_MESSAGE_MAX_LENGTH): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  if (normalized.length <= maxLength) return [normalized]

  const chunks: string[] = []
  let remaining = normalized

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength)
    if (splitIndex < Math.floor(maxLength * 0.5)) {
      splitIndex = remaining.lastIndexOf('\n', maxLength)
    }
    if (splitIndex < Math.floor(maxLength * 0.5)) {
      splitIndex = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitIndex <= 0) {
      splitIndex = maxLength
    }

    const chunk = remaining.slice(0, splitIndex).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(splitIndex).trim()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

export class TelegramThreadBridge {
  private token: string
  private readonly appServer: AppServerLike
  private readonly defaultCwd: string
  private allowAllUsers = false
  private allowedUserIds = new Set<number>()
  private readonly threadIdByChatId = new Map<number, string>()
  private readonly chatIdsByThreadId = new Map<string, Set<number>>()
  private readonly languageByChatId = new Map<number, TelegramLanguage>()
  private notificationChatIds = new Set<number>()
  private readonly lastForwardedTurnByThreadId = new Map<string, string>()
  private readonly turnStartedAtByKey = new Map<string, number>()
  private readonly processingCompletionKeys = new Set<string>()
  private active = false
  private pollingTask: Promise<void> | null = null
  private notificationUnsubscribe: (() => void) | null = null
  private nextUpdateOffset = 0
  private lastError = ''
  private readonly onChatSeen?: (chatId: number) => void

  constructor(appServer: AppServerLike, options: TelegramThreadBridgeOptions = {}) {
    this.appServer = appServer
    this.token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
    this.defaultCwd = process.env.TELEGRAM_DEFAULT_CWD?.trim() ?? process.cwd()
    this.configureAllowedUserIds(
      (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
    this.configureNotificationChatIds(
      (process.env.TELEGRAM_NOTIFICATION_CHAT_IDS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
    this.onChatSeen = options.onChatSeen
  }

  start(): void {
    if (!this.token || this.active) return
    this.active = true
    void this.syncBotCommands().catch(() => {})
    void this.notifyOnlineForKnownChats().catch(() => {})
    this.pollingTask = this.pollLoop()
    this.notificationUnsubscribe = this.appServer.onNotification((notification) => {
      void this.handleNotification(notification).catch(() => {})
    })
  }

  stop(): void {
    this.active = false
    this.notificationUnsubscribe?.()
    this.notificationUnsubscribe = null
  }

  private async pollLoop(): Promise<void> {
    while (this.active) {
      try {
        const updates = await this.getUpdates()
        this.lastError = ''
        for (const update of updates) {
          const updateId = typeof update.update_id === 'number' ? update.update_id : -1
          if (updateId >= 0) {
            this.nextUpdateOffset = Math.max(this.nextUpdateOffset, updateId + 1)
          }
          await this.handleIncomingUpdate(update)
        }
      } catch (error) {
        this.lastError = getErrorMessage(error, 'Telegram polling failed')
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    if (!this.token) {
      throw new Error('Telegram bot token is not configured')
    }
    const response = await fetch(this.apiUrl('getUpdates'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeout: 45,
        offset: this.nextUpdateOffset,
        allowed_updates: ['message', 'callback_query'],
      }),
    })
    const payload = asRecord(await response.json())
    const result = Array.isArray(payload?.result) ? payload.result : []
    return result as TelegramUpdate[]
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`
  }

  configureToken(token: string): void {
    const normalizedToken = token.trim()
    if (!normalizedToken) {
      throw new Error('Telegram bot token is required')
    }
    this.token = normalizedToken
    void this.syncBotCommands().catch(() => {})
  }

  getStatus(): TelegramBridgeStatus {
    return {
      configured: this.token.length > 0,
      active: this.active,
      mappedChats: this.threadIdByChatId.size,
      mappedThreads: this.chatIdsByThreadId.size,
      notificationChats: this.notificationChatIds.size,
      allowedUsers: this.allowedUserIds.size,
      allowAllUsers: this.allowAllUsers,
      lastError: this.lastError,
    }
  }

  configureAllowedUserIds(allowedUserIds: unknown): void {
    const normalized = normalizeTelegramAllowlist(allowedUserIds)
    this.allowAllUsers = normalized.allowAllUsers
    this.allowedUserIds = new Set(normalized.allowedUserIds)
  }

  configureNotificationChatIds(notificationChatIds: unknown): void {
    this.notificationChatIds = new Set(normalizeTelegramChatIds(notificationChatIds))
  }

  connectThread(threadId: string, chatId: number, token?: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) {
      throw new Error('threadId is required')
    }
    if (!Number.isFinite(chatId)) {
      throw new Error('chatId must be a number')
    }
    if (typeof token === 'string' && token.trim().length > 0) {
      this.configureToken(token)
    }
    if (!this.token) {
      throw new Error('Telegram bot token is not configured')
    }
    this.bindChatToThread(chatId, normalizedThreadId)
    this.markChatSeen(chatId)
    this.start()
    void this.sendOnlineMessage(chatId).catch(() => {})
  }

  private markChatSeen(chatId: number): void {
    if (!Number.isFinite(chatId)) return
    this.onChatSeen?.(Math.trunc(chatId))
  }

  private async sendTelegramMessage(
    chatId: number,
    text: string,
    options: { replyMarkup?: unknown } = {},
  ): Promise<void> {
    const chunks = splitTelegramText(text)
    if (chunks.length === 0) return

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      const replyMarkup = index === 0 ? options.replyMarkup : undefined
      const htmlChunk = renderMarkdownToTelegramHtml(chunk)
      try {
        await this.sendMessageRequest(chatId, htmlChunk, { replyMarkup, parseMode: 'HTML' })
      } catch {
        await this.sendMessageRequest(chatId, chunk, { replyMarkup })
      }
    }
  }

  private async sendMessageRequest(
    chatId: number,
    text: string,
    options: { replyMarkup?: unknown; parseMode?: 'HTML' } = {},
  ): Promise<void> {
    const payload: Record<string, unknown> = { chat_id: chatId, text }
    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup
    }
    if (options.parseMode) {
      payload.parse_mode = options.parseMode
    }
    await this.callTelegramApi('sendMessage', payload)
  }

  private async syncBotCommands(): Promise<void> {
    if (!this.token) return
    await Promise.all([
      this.callTelegramApi('setMyCommands', { commands: TELEGRAM_BOT_COMMANDS_FA }),
      this.callTelegramApi('setMyCommands', { commands: TELEGRAM_BOT_COMMANDS_FA, language_code: 'fa' }),
      this.callTelegramApi('setMyCommands', { commands: TELEGRAM_BOT_COMMANDS_EN, language_code: 'en' }),
    ])
  }

  private async callTelegramApi(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(this.apiUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const parsed = asRecord(await response.json())
    const ok = parsed?.ok === true
    if (!response.ok || !ok) {
      const description = typeof parsed?.description === 'string' ? parsed.description : ''
      const statusPart = `${String(response.status)} ${response.statusText}`.trim()
      throw new Error(description || statusPart || `Telegram API ${method} failed`)
    }
    return parsed ?? {}
  }

  private async sendOnlineMessage(chatId: number): Promise<void> {
    await this.sendTelegramMessage(chatId, telegramText(this.languageForChat(chatId), 'online'))
  }

  private async notifyOnlineForKnownChats(): Promise<void> {
    const knownChatIds = Array.from(this.threadIdByChatId.keys())
    for (const chatId of knownChatIds) {
      await this.sendOnlineMessage(chatId)
    }
  }

  private languageForChat(chatId: number): TelegramLanguage {
    return this.languageByChatId.get(chatId) ?? DEFAULT_TELEGRAM_LANGUAGE
  }

  private async handleLanguageCommand(chatId: number, argument: string | undefined): Promise<void> {
    if (!argument) {
      const language = this.languageForChat(chatId)
      const languageLabel = language === 'fa' ? 'فارسی' : 'English'
      await this.sendTelegramMessage(
        chatId,
        `${telegramText(language, 'languageCurrent')}: ${languageLabel}\n${telegramText(language, 'languageUsage')}`,
      )
      return
    }

    const language = normalizeTelegramLanguage(argument)
    if (!language) {
      await this.sendTelegramMessage(chatId, telegramText(this.languageForChat(chatId), 'languageUnknown'))
      return
    }

    this.languageByChatId.set(chatId, language)
    await this.sendTelegramMessage(chatId, telegramText(language, 'languageSet'))
  }

  private async handleIncomingUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query)
      return
    }

    const message = update.message
    const chatId = message?.chat?.id
    const senderId = message?.from?.id
    const text = message?.text?.trim()
    if (typeof chatId !== 'number' || !text) return
    const language = this.languageForChat(chatId)
    if (!this.isAllowedSender(senderId)) {
      await this.sendTelegramMessage(chatId, this.unauthorizedMessage(senderId, language))
      return
    }
    this.markChatSeen(chatId)

    const languageCommand = text.match(/^\/language(?:@[^\s]+)?(?:\s+([^\s]+))?$/i)
    if (languageCommand) {
      await this.handleLanguageCommand(chatId, languageCommand[1])
      return
    }

    if (text === '/start') {
      await this.sendTelegramMessage(chatId, this.helpMessage(language))
      await this.sendThreadPicker(chatId)
      return
    }

    if (text === '/threads') {
      await this.sendThreadPicker(chatId)
      return
    }

    if (text === '/newthread') {
      const threadId = await this.createThreadForChat(chatId)
      await this.sendTelegramMessage(chatId, language === 'fa'
        ? `به ترد جدید متصل شد: ${threadId}`
        : `Mapped to new thread: ${threadId}`)
      return
    }

    const threadCommand = text.match(/^\/thread\s+(\S+)$/)
    if (threadCommand) {
      const threadId = threadCommand[1]
      this.bindChatToThread(chatId, threadId)
      await this.sendTelegramMessage(chatId, language === 'fa'
        ? `به ترد متصل شد: ${threadId}`
        : `Mapped to thread: ${threadId}`)
      return
    }

    if (text === '/current') {
      const threadId = this.threadIdByChatId.get(chatId)
      await this.sendTelegramMessage(chatId, threadId
        ? language === 'fa' ? `ترد فعلی: \`${threadId}\`` : `Current thread: \`${threadId}\``
        : telegramText(language, 'noCurrentThread'))
      return
    }

    if (text === '/history') {
      const threadId = this.threadIdByChatId.get(chatId)
      if (!threadId) {
        await this.sendTelegramMessage(chatId, telegramText(language, 'noCurrentThreadShort'))
        return
      }
      const history = await this.readThreadHistorySummary(threadId, language)
      await this.sendTelegramMessage(chatId, history)
      return
    }

    if (text === '/status') {
      const status = this.getStatus()
      const mappedThreadId = this.threadIdByChatId.get(chatId) ?? 'none'
      await this.sendTelegramMessage(
        chatId,
        [
          `**${telegramText(language, 'bridgeStatus')}**`,
          `${telegramText(language, 'configured')}: ${String(status.configured)}`,
          `${telegramText(language, 'active')}: ${String(status.active)}`,
          `${telegramText(language, 'mappedChats')}: ${String(status.mappedChats)}`,
          `${telegramText(language, 'mappedThreads')}: ${String(status.mappedThreads)}`,
          `${telegramText(language, 'allowedUsers')}: ${String(status.allowedUsers)}`,
          `${telegramText(language, 'allowAllUsers')}: ${String(status.allowAllUsers)}`,
          `${telegramText(language, 'threadForChat').replace('{chatId}', String(chatId))}: \`${mappedThreadId}\``,
          status.lastError ? `${telegramText(language, 'lastError')}: ${status.lastError}` : '',
        ].filter(Boolean).join('\n'),
      )
      return
    }

    if (text === '/whoami') {
      const normalizedSenderId = typeof senderId === 'number' && Number.isFinite(senderId)
        ? String(Math.trunc(senderId))
        : 'unknown'
      const normalizedChatId = String(Math.trunc(chatId))
      await this.sendTelegramMessage(
        chatId,
        [
          `**${telegramText(language, 'identity')}**`,
          `${telegramText(language, 'telegramUserId')}: \`${normalizedSenderId}\``,
          `${telegramText(language, 'chatId')}: \`${normalizedChatId}\``,
          `${telegramText(language, 'authorized')}: ${String(this.isAllowedSender(senderId))}`,
          this.allowAllUsers
            ? telegramText(language, 'allowlistAll')
            : telegramText(language, 'allowlistExplicit'),
        ].join('\n'),
      )
      return
    }

    if (text === '/help') {
      await this.sendTelegramMessage(chatId, this.helpMessage(language))
      return
    }

    const threadId = await this.ensureThreadForChat(chatId)
    try {
      await this.appServer.rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
      })
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to forward message to thread')
      await this.sendTelegramMessage(chatId, `${telegramText(language, 'forwardFailed')}: ${message}`)
    }
  }

  private async handleCallbackQuery(callbackQuery: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const callbackId = typeof callbackQuery.id === 'string' ? callbackQuery.id : ''
    const data = typeof callbackQuery.data === 'string' ? callbackQuery.data : ''
    const chatId = callbackQuery.message?.chat?.id
    const senderId = callbackQuery.from?.id
    const language = typeof chatId === 'number' ? this.languageForChat(chatId) : DEFAULT_TELEGRAM_LANGUAGE
    if (!this.isAllowedSender(senderId)) {
      if (callbackId) {
        await this.answerCallbackQuery(callbackId, this.unauthorizedCallbackMessage(senderId, language))
      }
      if (typeof chatId === 'number') {
        await this.sendTelegramMessage(chatId, this.unauthorizedMessage(senderId, language))
      }
      return
    }
    if (typeof chatId === 'number') {
      this.markChatSeen(chatId)
    }
    if (!callbackId) return

    if (!data.startsWith('thread:') || typeof chatId !== 'number') {
      await this.answerCallbackQuery(callbackId, telegramText(language, 'invalidSelection'))
      return
    }

    const threadId = data.slice('thread:'.length).trim()
    if (!threadId) {
      await this.answerCallbackQuery(callbackId, telegramText(language, 'invalidThreadId'))
      return
    }

    this.bindChatToThread(chatId, threadId)
    await this.answerCallbackQuery(callbackId, telegramText(language, 'threadConnected'))
    await this.sendTelegramMessage(chatId, language === 'fa'
      ? `به ترد متصل شد: ${threadId}`
      : `Connected to thread: ${threadId}`)
    const history = await this.readThreadHistorySummary(threadId, language)
    if (history) {
      await this.sendTelegramMessage(chatId, history)
    }
  }

  private isAllowedSender(senderId: unknown): senderId is number {
    if (this.allowAllUsers) {
      return typeof senderId === 'number' && Number.isFinite(senderId)
    }
    return typeof senderId === 'number'
      && Number.isFinite(senderId)
      && this.allowedUserIds.has(Math.trunc(senderId))
  }

  private unauthorizedMessage(senderId: unknown, language: TelegramLanguage): string {
    const normalizedSenderId = typeof senderId === 'number' && Number.isFinite(senderId)
        ? String(Math.trunc(senderId))
        : 'unknown'
    return language === 'fa'
      ? `فرستنده مجاز نیست.\n\nشناسه کاربر تلگرام شما: ${normalizedSenderId}\nبرای استفاده از پل، این شناسه را به فهرست کاربران مجاز ربات اضافه کنید.`
      : `Unauthorized sender.\n\nYour Telegram user ID: ${normalizedSenderId}\nAdd this ID to the bot allowlist before using the bridge.`
  }

  private unauthorizedCallbackMessage(senderId: unknown, language: TelegramLanguage): string {
    if (typeof senderId === 'number' && Number.isFinite(senderId)) {
      return language === 'fa'
        ? `غیرمجاز: ${String(Math.trunc(senderId))}`
        : `Unauthorized: ${String(Math.trunc(senderId))}`
    }
    return language === 'fa' ? 'فرستنده مجاز نیست' : 'Unauthorized sender'
  }

  private helpMessage(language: TelegramLanguage): string {
    const commands = language === 'fa' ? TELEGRAM_BOT_COMMANDS_FA : TELEGRAM_BOT_COMMANDS_EN
    const heading = language === 'fa' ? '**فرمان‌های موجود**' : '**Available commands**'
    const rows = commands.map((command) => `/${command.command} - ${command.description}`)
    return [heading, ...rows].join('\n')
  }

  private async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.callTelegramApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    })
  }

  private async sendThreadPicker(chatId: number): Promise<void> {
    const language = this.languageForChat(chatId)
    const threads = await this.listRecentThreads()
    if (threads.length === 0) {
      await this.sendTelegramMessage(chatId, telegramText(language, 'noThreads'))
      return
    }

    const inlineKeyboard = threads.map((thread) => [
      {
        text: thread.title,
        callback_data: `thread:${thread.id}`,
      },
    ])

    await this.sendTelegramMessage(chatId, telegramText(language, 'selectThread'), {
      replyMarkup: { inline_keyboard: inlineKeyboard },
    })
  }

  private async listRecentThreads(): Promise<Array<{ id: string; title: string }>> {
    const payload = asRecord(await this.appServer.rpc('thread/list', {
      archived: false,
      limit: 20,
      sortKey: 'updated_at',
      modelProviders: [],
    }))
    const rows = Array.isArray(payload?.data) ? payload.data : []
    const threads: Array<{ id: string; title: string }> = []
    for (const row of rows) {
      const record = asRecord(row)
      const id = typeof record?.id === 'string' ? record.id.trim() : ''
      if (!id) continue
      const name = typeof record?.name === 'string' ? record.name.trim() : ''
      const preview = typeof record?.preview === 'string' ? record.preview.trim() : ''
      const cwd = typeof record?.cwd === 'string' ? record.cwd.trim() : ''
      const projectName = cwd ? basename(cwd) : 'project'
      const threadTitle = (name || preview || id).replace(/\s+/g, ' ').trim()
      const title = `${projectName}/${threadTitle}`.slice(0, 64)
      threads.push({ id, title })
    }
    return threads
  }

  private async createThreadForChat(chatId: number): Promise<string> {
    const response = asRecord(await this.appServer.rpc('thread/start', { cwd: this.defaultCwd }))
    const thread = asRecord(response?.thread)
    const threadId = typeof thread?.id === 'string' ? thread.id : ''
    if (!threadId) {
      throw new Error('thread/start did not return thread id')
    }
    this.bindChatToThread(chatId, threadId)
    return threadId
  }

  private async ensureThreadForChat(chatId: number): Promise<string> {
    const existing = this.threadIdByChatId.get(chatId)
    if (existing) return existing
    return this.createThreadForChat(chatId)
  }

  private bindChatToThread(chatId: number, threadId: string): void {
    const previousThreadId = this.threadIdByChatId.get(chatId)
    if (previousThreadId && previousThreadId !== threadId) {
      const previousSet = this.chatIdsByThreadId.get(previousThreadId)
      previousSet?.delete(chatId)
      if (previousSet && previousSet.size === 0) {
        this.chatIdsByThreadId.delete(previousThreadId)
      }
    }
    this.threadIdByChatId.set(chatId, threadId)
    const chatIds = this.chatIdsByThreadId.get(threadId) ?? new Set<number>()
    chatIds.add(chatId)
    this.chatIdsByThreadId.set(threadId, chatIds)
  }

  private extractThreadId(notification: { method: string; params: unknown }): string {
    const params = asRecord(notification.params)
    if (!params) return ''
    const directThreadId = typeof params.threadId === 'string' ? params.threadId : ''
    if (directThreadId) return directThreadId
    const turn = asRecord(params.turn)
    const turnThreadId = typeof turn?.threadId === 'string' ? turn.threadId : ''
    return turnThreadId
  }

  private extractTurnId(notification: { method: string; params: unknown }): string {
    const params = asRecord(notification.params)
    if (!params) return ''
    const directTurnId = typeof params.turnId === 'string' ? params.turnId : ''
    if (directTurnId) return directTurnId
    const turn = asRecord(params.turn)
    const turnId = typeof turn?.id === 'string' ? turn.id : ''
    return turnId
  }

  private async handleNotification(notification: { method: string; params: unknown }): Promise<void> {
    if (notification.method === 'turn/started') {
      const threadId = this.extractThreadId(notification)
      if (!threadId) return
      const turnId = this.extractTurnId(notification)
      this.turnStartedAtByKey.set(`${threadId}:${turnId}`, Date.now())
      return
    }
    if (notification.method !== 'turn/completed') return
    const threadId = this.extractThreadId(notification)
    if (!threadId) return
    const mappedChatIds = this.chatIdsByThreadId.get(threadId) ?? new Set<number>()
    if (mappedChatIds.size === 0 && this.notificationChatIds.size === 0) return

    const turnId = this.extractTurnId(notification)
    const lastForwardedTurnId = this.lastForwardedTurnByThreadId.get(threadId)
    if (turnId && lastForwardedTurnId === turnId) return

    const completionKey = `${threadId}:${turnId}`
    if (this.processingCompletionKeys.has(completionKey)) return
    this.processingCompletionKeys.add(completionKey)

    try {
      const startedAt = this.turnStartedAtByKey.get(completionKey) ?? this.turnStartedAtByKey.get(`${threadId}:`)
      this.turnStartedAtByKey.delete(completionKey)
      this.turnStartedAtByKey.delete(`${threadId}:`)
      const status = this.extractTurnStatus(notification)
      const errorMessage = this.extractTurnErrorMessage(notification)
      const snapshot = await this.readThreadCompletionSnapshot(threadId)
      const completionInput = {
        threadId,
        turnId,
        status,
        durationMs: startedAt === undefined ? null : Date.now() - startedAt,
        title: snapshot.title,
        model: this.extractTurnModel(notification) || snapshot.model,
        assistantReply: snapshot.assistantReply,
        errorMessage,
      }
      const notificationRecipients = new Set(this.notificationChatIds)
      const sends: Array<Promise<void>> = []
      for (const chatId of mappedChatIds) {
        const completionMessage = this.buildCompletionNotification({
          ...completionInput,
          language: this.languageForChat(chatId),
        })
        sends.push(this.sendTelegramMessage(
          chatId,
          notificationRecipients.has(chatId) || !snapshot.assistantReply
            ? completionMessage
            : snapshot.assistantReply,
        ))
      }
      for (const chatId of notificationRecipients) {
        if (mappedChatIds.has(chatId)) continue
        sends.push(this.sendTelegramMessage(chatId, this.buildCompletionNotification({
          ...completionInput,
          language: this.languageForChat(chatId),
        })))
      }
      await Promise.all(sends)
      if (turnId) {
        this.lastForwardedTurnByThreadId.set(threadId, turnId)
      }
    } finally {
      this.processingCompletionKeys.delete(completionKey)
    }
  }

  private extractTurnStatus(notification: { method: string; params: unknown }): string {
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    const status = typeof turn?.status === 'string' ? turn.status.trim() : ''
    return status || (typeof params?.status === 'string' ? params.status.trim() : '') || 'completed'
  }

  private extractTurnErrorMessage(notification: { method: string; params: unknown }): string {
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    const error = asRecord(turn?.error)
    return typeof error?.message === 'string' ? error.message.trim() : ''
  }

  private extractTurnModel(notification: { method: string; params: unknown }): string {
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    return (
      typeof turn?.model === 'string' ? turn.model.trim() : ''
    ) || (
      typeof params?.model === 'string' ? params.model.trim() : ''
    )
  }

  private buildCompletionNotification(input: {
    threadId: string
    turnId: string
    status: string
    durationMs: number | null
    title: string
    model: string
    assistantReply: string
    errorMessage: string
    language: TelegramLanguage
  }): string {
    const statusLabel = input.status || 'completed'
    const heading = input.language === 'fa'
      ? statusLabel === 'completed'
        ? '✅ **اجرای ترد Codex تمام شد**'
        : `⚠️ **اجرای ترد Codex ${translateTelegramStatus(statusLabel, input.language)}**`
      : statusLabel === 'completed'
        ? '✅ **Codex thread finished**'
        : `⚠️ **Codex thread ${statusLabel}**`
    const rows = [
      heading,
      input.title ? `${input.language === 'fa' ? '**ترد:**' : '**Thread:**'} ${input.title}` : '',
      `${input.language === 'fa' ? '**شناسه:**' : '**ID:**'} \`${input.threadId}\``,
      input.turnId ? `${input.language === 'fa' ? '**نوبت:**' : '**Turn:**'} \`${input.turnId}\`` : '',
      input.model ? `${input.language === 'fa' ? '**مدل:**' : '**Model:**'} \`${input.model}\`` : '',
      `${input.language === 'fa' ? '**زمان سپری‌شده:**' : '**Elapsed:**'} ${formatTelegramDuration(input.durationMs, input.language)}`,
      input.errorMessage
        ? `${input.language === 'fa' ? '**خطا:**' : '**Error:**'} ${input.errorMessage}`
        : '',
      input.assistantReply ? `\n${input.assistantReply}` : '',
    ].filter(Boolean)
    return rows.join('\n')
  }

  private async readThreadCompletionSnapshot(threadId: string): Promise<{
    title: string
    model: string
    assistantReply: string
  }> {
    const response = asRecord(await this.appServer.rpc('thread/read', { threadId, includeTurns: true }))
    const thread = asRecord(response?.thread)
    const turns = Array.isArray(thread?.turns) ? thread.turns : []
    const title = (
      typeof thread?.name === 'string' ? thread.name.trim() : ''
    ) || (
      typeof thread?.preview === 'string' ? thread.preview.trim() : ''
    ) || threadId
    let model = typeof thread?.model === 'string' ? thread.model.trim() : ''

    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = asRecord(turns[turnIndex])
      if (!model && typeof turn?.model === 'string') model = turn.model.trim()
      const items = Array.isArray(turn?.items) ? turn.items : []
      for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const item = asRecord(items[itemIndex])
        if (item?.type === 'agentMessage') {
          const text = typeof item.text === 'string' ? item.text.trim() : ''
          if (text) return { title, model, assistantReply: text }
        }
      }
    }
    return { title, model, assistantReply: '' }
  }

  private async readThreadHistorySummary(threadId: string, language: TelegramLanguage): Promise<string> {
    const response = asRecord(await this.appServer.rpc('thread/read', { threadId, includeTurns: true }))
    const thread = asRecord(response?.thread)
    const turns = Array.isArray(thread?.turns) ? thread.turns : []
    const historyRows: string[] = []

    for (const turn of turns) {
      const turnRecord = asRecord(turn)
      const items = Array.isArray(turnRecord?.items) ? turnRecord.items : []
      for (const item of items) {
        const itemRecord = asRecord(item)
        const type = typeof itemRecord?.type === 'string' ? itemRecord.type : ''
        if (type === 'userMessage') {
          const content = Array.isArray(itemRecord?.content) ? itemRecord.content : []
          for (const block of content) {
            const blockRecord = asRecord(block)
            if (blockRecord?.type === 'text' && typeof blockRecord.text === 'string' && blockRecord.text.trim()) {
              historyRows.push(`${telegramText(language, 'userLabel')}: ${blockRecord.text.trim()}`)
            }
          }
        }
        if (type === 'agentMessage' && typeof itemRecord?.text === 'string' && itemRecord.text.trim()) {
          historyRows.push(`${telegramText(language, 'assistantLabel')}: ${itemRecord.text.trim()}`)
        }
      }
    }

    if (historyRows.length === 0) {
      return telegramText(language, 'historyEmpty')
    }

    const tail = historyRows.slice(-12).join('\n\n')
    const maxLen = 3800
    const summary = tail.length > maxLen ? tail.slice(tail.length - maxLen) : tail
    return `${telegramText(language, 'recentHistory')}\n\n${summary}`
  }
}
