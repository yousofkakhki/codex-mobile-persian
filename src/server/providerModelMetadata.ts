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

export function normalizeProviderModelMetadata(payload: unknown): ZenModelMetadata[] {
  const body = record(payload)
  const rows = Array.isArray(body.data) && body.data.length ? body.data : body.models
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  return rows.flatMap(value => {
    const row = record(value)
    const id = [row.id, row.slug, row.model].find(v => typeof v === 'string' && v.trim())
    if (typeof id !== 'string' || seen.has(id.trim())) return []
    seen.add(id.trim())
    const capabilities = record(row.capabilities)
    const supportsReasoning = boolean(capabilities.reasoning ?? row.reasoning)
    const rawEfforts = row.supportedReasoningEfforts ?? row.supported_reasoning_efforts ?? row.thinkingLevels
    const explicit = Array.isArray(rawEfforts) ? rawEfforts.flatMap(value => {
      const effort = typeof value === 'string' ? value : record(value).reasoningEffort ?? record(value).reasoning_effort
      return typeof effort === 'string' ? [effort] : []
    }) : null
    // NineRouter's Codex executor has per-model thinkingLevels, while its
    // generic capabilities currently incorrectly advertise effort support=false.
    // Keep this fallback explicit and restricted to the inspected cx families.
    const cxReasoning = /^cx\/gpt-(?:6(?:\.1)?-(?:astra|sol|luna)|5\.6-(?:sol|terra|luna)|5\.5)(?:\[1m\])?(?:-review)?$/u.test(id.trim())
    const astra = /^cx\/gpt-6-astra(?:\[1m\])?$/u.test(id.trim())
    const fallback = cxReasoning ? ['low', 'medium', 'high', 'xhigh', ...(astra ? [] : ['max'])] : []
    const reasoningOptions = supportsReasoning === false ? [] : explicit ?? fallback
    return [{
      id: id.trim(), name: typeof row.name === 'string' ? row.name : id.trim(),
      upstreamApi: 'responses' as const, routingSource: 'provider-catalog' as const,
      contextWindow: positive(row.context_length) ?? positive(capabilities.contextWindow) ?? positive(row.context_window),
      maxOutputTokens: positive(row.max_completion_tokens) ?? positive(capabilities.maxOutput),
      supportsReasoning, supportsTools: boolean(capabilities.tools),
      inputModalities: boolean(capabilities.vision) === true ? ['text', 'image'] : null,
      reasoningOptions, reasoningSource: explicit ? 'provider-catalog' as const : 'codex-family-fallback' as const,
      free: false, discoveredAt: new Date().toISOString(),
    }]
  })
}
