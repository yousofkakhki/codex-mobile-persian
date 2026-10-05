import type { ReasoningEffort } from '../types/codex'
import type { ZenModelMetadata } from '../types/zenModels'

const STANDARD_REASONING_EFFORTS: ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase()
}

export function normalizeModelIdForProvider(modelId: string, providerId: string): string {
  const normalizedModelId = modelId.trim()
  if (!normalizedModelId) return ''

  const normalizedProviderId = providerId.trim().toLowerCase().replace(/_/g, '-')
  if (normalizedProviderId === 'ninerouter' && /^gpt-/i.test(normalizedModelId)) {
    return `cx/${normalizedModelId}`
  }

  return normalizedModelId
}

export function isUltraReasoningModel(modelId: string): boolean {
  return /^(?:cx\/)?gpt-6-astra(?:\[1m\])?(?:$|-)/u.test(normalizeModelId(modelId))
}

export function isFastModeSupported(modelId: string): boolean {
  return /^(?:cx\/)?gpt-(?:5\.(?:4|5|6)|6(?:\.1)?-(?:astra|sol|luna))(?:\[1m\])?(?:$|-)/u.test(normalizeModelId(modelId))
}

export function getFastModeCreditMultiplier(modelId: string): 2 | 2.5 {
  return /^(?:cx\/)?gpt-5\.4(?:$|-)/u.test(normalizeModelId(modelId)) ? 2 : 2.5
}

export function getModelReasoningEfforts(modelId: string, metadata?: Partial<ZenModelMetadata>): ReasoningEffort[] {
  if (metadata?.supportsReasoning === false) return []
  const allowed = [...STANDARD_REASONING_EFFORTS, 'ultra'] as ReasoningEffort[]
  const explicit = metadata?.reasoningOptions?.filter((value): value is ReasoningEffort =>
    typeof value === 'string' && allowed.includes(value as ReasoningEffort))
  if (explicit?.length) return [...new Set(explicit)]
  return isUltraReasoningModel(modelId) ? [...STANDARD_REASONING_EFFORTS, 'ultra'] : [...STANDARD_REASONING_EFFORTS]
}

export function resolveModelContextWindow(runtime: number | null | undefined, advertised: number | null | undefined): number | null {
  for (const value of [runtime, advertised]) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return null
}

export function getContextWindowStatus(measured: number | null | undefined, metadata?: Partial<ZenModelMetadata>) {
  const measuredWindow = resolveModelContextWindow(measured, null)
  const configuredWindow = resolveModelContextWindow(metadata?.configuredContextWindow, null)
  return {
    measuredWindow, configuredWindow,
    differs: measuredWindow !== null && configuredWindow !== null && measuredWindow !== configuredWindow,
  }
}

export function isReasoningEffortSupported(modelId: string, effort: ReasoningEffort | '', metadata?: Partial<ZenModelMetadata>): boolean {
  if (!effort) return true
  if (metadata) return getModelReasoningEfforts(modelId, metadata).includes(effort)
  if (effort === 'ultra') return isUltraReasoningModel(modelId)
  return STANDARD_REASONING_EFFORTS.includes(effort)
}
