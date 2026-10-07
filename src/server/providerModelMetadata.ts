import type { ZenModelMetadata } from '../types/zenModels.js'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

const ALLOWED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function normalizeProviderModelMetadata(payload: unknown): ZenModelMetadata[] {
  const body = record(payload)
  const rows = Array.isArray(body.data) && body.data.length ? body.data : body.models
  if (!Array.isArray(rows)) return []
  const discoveredAt = new Date().toISOString()
  const seen = new Set<string>()
  const counts = new Map<string, number>()
  for (const value of rows) {
    const row = record(value)
    const id = [typeof value === 'string' ? value : null, row.id, row.model, row.slug].find(v => typeof v === 'string' && v.trim())
    if (typeof id === 'string' && id.startsWith('cx/')) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return rows.flatMap(value => {
    const row = record(value)
    const id = [typeof value === 'string' ? value : null, row.id, row.model, row.slug].find(v => typeof v === 'string' && v.trim())
    if (typeof id !== 'string' || seen.has(id)) return []
    seen.add(id)
    const capabilities = record(row.capabilities)
    const supportsReasoning = capabilities.reasoning === false || row.reasoning === false ? false : boolean(capabilities.reasoning ?? row.reasoning)
    const effortKeys = ['supportedReasoningEfforts', 'supported_reasoning_efforts', 'thinkingLevels'].filter(key => Object.prototype.hasOwnProperty.call(row, key))
    let explicit: string[] | null = null
    for (const key of effortKeys) {
      const rawEfforts = row[key]
      const efforts = Array.isArray(rawEfforts) ? Array.from(rawEfforts, value =>
        typeof value === 'string' ? value : record(value).reasoningEffort ?? record(value).reasoning_effort) : []
      if (!Array.isArray(rawEfforts) || efforts.some(effort => typeof effort !== 'string' || !ALLOWED_REASONING_EFFORTS.has(effort))) { explicit = []; break }
      const normalized = [...new Set(efforts)] as string[]
      explicit = explicit === null ? normalized : explicit.filter(effort => normalized.includes(effort))
    }
    if ((counts.get(id) ?? 0) > 1) explicit = [] // An ambiguous route declaration cannot establish local capabilities.
    // Restrict inference to inspected NineRouter Codex families. Its generic
    // thinkingEffortSupported=false does not describe the Codex executor.
    const cxReasoning = /^cx\/gpt-(?:6(?:\.1)?-(?:astra|sol|luna)|5\.6-(?:sol|terra|luna)|5\.5)(?:\[1m\])?(?:-review)?$/u.test(id)
    const astra = /^cx\/gpt-6-astra(?:\[1m\])?(?:-review)?$/u.test(id)
    const fallback = cxReasoning ? ['low', 'medium', 'high', 'xhigh', ...(astra ? [] : ['max'])] : []
    return [{
      id, name: typeof row.name === 'string' ? row.name : id,
      upstreamApi: 'responses' as const, routingSource: 'provider-catalog' as const,
      contextWindow: positive(row.context_length) ?? positive(capabilities.contextWindow) ?? positive(row.context_window),
      maxOutputTokens: positive(row.max_completion_tokens) ?? positive(capabilities.maxOutput),
      supportsReasoning, supportsTools: boolean(capabilities.tools),
      inputModalities: boolean(capabilities.vision) === true ? ['text', 'image'] : null,
      reasoningOptions: supportsReasoning === false ? [] : explicit ?? fallback,
      ...(explicit !== null ? { reasoningSource: 'provider-catalog' as const }
        : cxReasoning ? { reasoningSource: 'codex-family-fallback' as const } : {}),
      free: false, discoveredAt,
    }]
  })
}
