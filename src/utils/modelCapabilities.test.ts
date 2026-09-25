import { describe, expect, it } from 'vitest'
import {
  getFastModeCreditMultiplier,
  isFastModeSupported,
  isReasoningEffortSupported,
  isUltraReasoningModel,
  normalizeModelIdForProvider,
} from './modelCapabilities'

describe('model capabilities', () => {
  it('keeps NineRouter GPT models in the cx namespace', () => {
    expect(normalizeModelIdForProvider('gpt-5.6-luna', 'ninerouter')).toBe('cx/gpt-5.6-luna')
    expect(normalizeModelIdForProvider('cx/gpt-5.6-luna', 'ninerouter')).toBe('cx/gpt-5.6-luna')
    expect(normalizeModelIdForProvider('gpt-5.6-luna', 'openai')).toBe('gpt-5.6-luna')
  })

  it('exposes Ultra only for GPT-6 Astra aliases', () => {
    expect(isUltraReasoningModel('cx/gpt-6-astra')).toBe(true)
    expect(isUltraReasoningModel('gpt-6-astra-2026-09-01')).toBe(true)
    expect(isUltraReasoningModel('cx/gpt-5.6-luna')).toBe(false)
    expect(isReasoningEffortSupported('cx/gpt-6-astra', 'ultra')).toBe(true)
    expect(isReasoningEffortSupported('cx/gpt-5.6-luna', 'ultra')).toBe(false)
  })

  it('supports Fast mode for documented model families and cx aliases', () => {
    expect(isFastModeSupported('gpt-5.4')).toBe(true)
    expect(isFastModeSupported('cx/gpt-5.6-luna')).toBe(true)
    expect(isFastModeSupported('cx/gpt-6-astra')).toBe(true)
    expect(isFastModeSupported('cx/gpt-6-sol')).toBe(true)
    expect(isFastModeSupported('cx/gpt-6-luna')).toBe(true)
    expect(isFastModeSupported('muse-spark-1.3-contributor-free')).toBe(false)
    expect(getFastModeCreditMultiplier('gpt-5.4-mini')).toBe(2)
    expect(getFastModeCreditMultiplier('cx/gpt-6-astra')).toBe(2.5)
  })
})
