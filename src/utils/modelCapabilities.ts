import type { ReasoningEffort } from '../types/codex'

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
  return /^(?:cx\/)?gpt-6-astra(?:$|-)/u.test(normalizeModelId(modelId))
}

export function isFastModeSupported(modelId: string): boolean {
  return /^(?:cx\/)?gpt-(?:5\.(?:4|5|6)|6-(?:astra|sol|luna))(?:$|-)/u.test(normalizeModelId(modelId))
}

export function getFastModeCreditMultiplier(modelId: string): 2 | 2.5 {
  return /^(?:cx\/)?gpt-5\.4(?:$|-)/u.test(normalizeModelId(modelId)) ? 2 : 2.5
}

export function isReasoningEffortSupported(modelId: string, effort: ReasoningEffort | ''): boolean {
  if (!effort) return true
  if (effort === 'ultra') return isUltraReasoningModel(modelId)
  return STANDARD_REASONING_EFFORTS.includes(effort)
}
