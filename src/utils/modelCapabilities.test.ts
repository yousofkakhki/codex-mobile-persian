import { describe, expect, it } from 'vitest'
import {
  getFastModeCreditMultiplier,
  isFastModeSupported,
  isReasoningEffortSupported,
  isUltraReasoningModel,
  normalizeModelIdForProvider,
  getModelReasoningEfforts,
  resolveModelContextWindow,
  getContextWindowStatus,
} from './modelCapabilities'

describe('model capabilities', () => {
  it('distinguishes historical context measurements from next-turn configuration', () => {
    expect(getContextWindowStatus(258400, { configuredContextWindow: 997500, contextWindow: 1050000 })).toEqual({
      measuredWindow: 258400, configuredWindow: 997500, differs: true,
    })
    expect(getContextWindowStatus(997500, { configuredContextWindow: 997500 })).toEqual({
      measuredWindow: 997500, configuredWindow: 997500, differs: false,
    })
    expect(getContextWindowStatus(258400, { contextWindow: 1050000 }).differs).toBe(false)
  })
  it('uses catalog reasoning levels and accepts extended-context aliases', () => {
    expect(getModelReasoningEfforts('cx/gpt-6.1-sol', { reasoningOptions: ['low', 'high', 'max'] })).toEqual(['low', 'high', 'max'])
    expect(getModelReasoningEfforts('cx/gpt-reserve', { supportsReasoning: false, reasoningOptions: [] })).toEqual([])
    expect(isUltraReasoningModel('cx/gpt-6-astra[1m]')).toBe(true)
    expect(isFastModeSupported('cx/gpt-6.1-sol')).toBe(true)
    expect(isFastModeSupported('cx/gpt-6-luna[1m]')).toBe(true)
  })

  it('keeps runtime context authoritative and uses advertised context when runtime is unknown', () => {
    expect(resolveModelContextWindow(272000, 1050000)).toBe(272000)
    expect(resolveModelContextWindow(null, 872000)).toBe(872000)
    expect(resolveModelContextWindow(null, -1)).toBeNull()
  })
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
