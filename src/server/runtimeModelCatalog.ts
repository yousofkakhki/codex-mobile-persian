import { open, stat } from 'node:fs/promises'

export function getConfiguredContextWindows(catalog: unknown, contextOverride?: unknown): Record<string, number> {
  const rows = (catalog as { models?: unknown[] } | null)?.models
  if (!Array.isArray(rows)) return {}
  const result: Record<string, number> = Object.create(null)
  for (const value of rows) {
    const model = value as Record<string, unknown> | null
    if (!model || typeof model.slug !== 'string') continue
    let context = model.context_window
    if (typeof contextOverride === 'number' && contextOverride > 0) {
      context = typeof model.max_context_window === 'number'
        ? Math.min(contextOverride, model.max_context_window) : contextOverride
    }
    const percent = model.effective_context_window_percent ?? 95
    if (typeof context !== 'number' || !Number.isSafeInteger(context) || context <= 0
      || typeof percent !== 'number' || !Number.isFinite(percent) || percent <= 0 || percent > 100) continue
    const effective = Math.floor(context * percent / 100)
    if (effective > 0) result[model.slug] = effective
  }
  return result
}


const MAX_CATALOG_BYTES = 4 * 1024 * 1024
let cached: { key: string; pending: Promise<unknown> } | undefined

export async function readConfiguredModelCatalog(): Promise<unknown> {
  const path = process.env.CODEXUI_MODEL_CATALOG_JSON?.trim()
  if (!path) return {}
  let entry: typeof cached
  try {
    const info = await stat(path)
    if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_CATALOG_BYTES) return {}
    const key = `${path}:${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.dev}:${info.ino}`
    if (cached?.key !== key) {
      cached = { key, pending: (async () => {
        const file = await open(path, 'r')
        try {
          const buffer = Buffer.alloc(info.size + 1)
          let total = 0
          while (total < buffer.length) {
            const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
            if (!bytesRead) break
            total += bytesRead
          }
          if (total > info.size) throw new Error('Catalog changed during read')
          return JSON.parse(buffer.subarray(0, total).toString('utf8')) as unknown
        } finally { await file.close() }
      })() }
    }
    entry = cached
    return await entry.pending
  } catch {
    if (!entry || cached === entry) cached = undefined
    return {} // Optional metadata must not make strict provider discovery unavailable.
  }
}

export async function readConfiguredContextWindows(contextOverride?: unknown): Promise<Record<string, number>> {
  return getConfiguredContextWindows(await readConfiguredModelCatalog(), contextOverride)
}
