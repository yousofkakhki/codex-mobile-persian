import { describe, expect, it } from 'vitest'
import { getModelReasoningEfforts, isReasoningEffortSupported, isUltraReasoningModel } from './modelCapabilities'
import type { ZenModelMetadata } from '../types/zenModels'

// Fresh safety assertions adapted from immutable observational witnesses. PASS
// now means the unsafe capability is absent, not that the old bug reproduced.
describe('PUB-ULTRA-01 exact capability evidence', () => {
  it.each(['cx/gpt-6-astra-unreviewed-suffix', 'gpt-6-astra-2026-09-01', 'cx/gpt-6-astra', 'cx/gpt-6-astra[1m]'])(
    'never grants Ultra by name alone: %s', id => {
      expect(getModelReasoningEfforts(id)).not.toContain('ultra')
      expect(isReasoningEffortSupported(id, 'ultra')).toBe(false)
      expect(isUltraReasoningModel(id)).toBe(false)
      expect(getModelReasoningEfforts(id)).toContain('max')
    })
  it.each([[], ['unknown'], ['max', 'ultra', null], null, 'ultra', {}].map(value => [value]))(
    'keeps explicit empty/malformed native runtime declarations restrictive: %j', reasoningOptions => {
      const metadata = { reasoningSource: 'codex-runtime-catalog', reasoningOptions } as Partial<ZenModelMetadata>
      expect(getModelReasoningEfforts('cx/gpt-6-astra', metadata)).toEqual([])
      expect(isReasoningEffortSupported('cx/gpt-6-astra', 'ultra', metadata)).toBe(false)
    })
  it('does not let family or SDK metadata claim a runtime-local Ultra mode', () => {
    expect(getModelReasoningEfforts('cx/gpt-6-astra', { reasoningSource: 'codex-family-fallback', reasoningOptions: ['max', 'ultra'] })).toEqual(['max'])
    expect(getModelReasoningEfforts('cx/gpt-6-astra', { reasoningOptions: ['max', 'ultra'], routingSource: 'sdk-metadata' })).toEqual(['max'])
  })
  it.each(['cx/gpt-6-astra', 'cx/gpt-6-astra[1m]', 'cx/gpt-6.1-sol', 'cx/gpt-6-sol[1m]', 'cx/gpt-5.6-sol-review'])(
    'preserves exact confirmed literal mode and distinct Max: %s', id => {
      const metadata = { id, reasoningSource: 'codex-runtime-catalog' as const, reasoningOptions: ['high', 'xhigh', 'max', 'ultra'] }
      expect(getModelReasoningEfforts(id, metadata)).toEqual(['high', 'xhigh', 'max', 'ultra'])
      expect(isReasoningEffortSupported(id, 'max', metadata)).toBe(true)
      expect(isReasoningEffortSupported(id, 'ultra', metadata)).toBe(true)
    })
  it('cannot use a different exact descriptor to authorize Ultra', () => {
    expect(isReasoningEffortSupported('cx/gpt-6-astra-unreviewed-suffix', 'ultra', {
      id: 'cx/gpt-6-astra', reasoningSource: 'codex-runtime-catalog', reasoningOptions: ['max', 'ultra'],
    })).toBe(false)
  })
  it('retains provider restrictions and explicit reasoning=false over permissive modes', () => {
    expect(getModelReasoningEfforts('cx/gpt-6-astra', { reasoningSource: 'provider-catalog', reasoningOptions: [] })).toEqual([])
    expect(getModelReasoningEfforts('cx/gpt-6-astra', { supportsReasoning: false, reasoningSource: 'codex-runtime-catalog', reasoningOptions: ['max', 'ultra'] })).toEqual([])
    expect(getModelReasoningEfforts('cx/gpt-6-astra', { reasoningSource: 'provider-catalog', reasoningOptions: ['low', 'max'] })).toEqual(['low', 'max'])
  })
})
