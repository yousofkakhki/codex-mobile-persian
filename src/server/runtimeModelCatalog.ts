import { readFile, stat } from 'node:fs/promises'

export function getConfiguredContextWindows(catalog: unknown, contextOverride?: unknown): Record<string, number> {
  const rows = (catalog as { models?: unknown[] } | null)?.models
  if (!Array.isArray(rows)) return {}
  const result: Record<string, number> = {}
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
      || typeof percent !== 'number' || percent <= 0 || percent > 100) continue
    result[model.slug] = Math.floor(context * percent / 100)
  }
  return result
}

let cached: { key: string; pending: Promise<unknown> } | undefined

export async function readConfiguredContextWindows(contextOverride?: unknown): Promise<Record<string, number>> {
  const path = process.env.CODEXUI_MODEL_CATALOG_JSON?.trim()
  if (!path) return {}
  try {
    const info = await stat(path)
    const key = `${path}:${info.mtimeMs}:${info.size}`
    if (cached?.key !== key) {
      cached = { key, pending: readFile(path, 'utf8').then(JSON.parse) }
    }
    return getConfiguredContextWindows(await cached.pending, contextOverride)
  } catch {
    cached = undefined
    return {} // Missing metadata must not turn provider discovery into an outage.
  }
}
