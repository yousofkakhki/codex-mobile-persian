import { describe, expect, it } from 'vitest'
import { normalizeProviderModelMetadata } from './providerModelMetadata'

describe('provider catalog metadata', () => {
  it('preserves NineRouter context and output limits without changing alias identifiers', () => {
    const models = normalizeProviderModelMetadata({ data: [{
      id: 'cx/gpt-6-luna[1m]', context_length: 872000, max_completion_tokens: 128000,
      capabilities: { reasoning: true, tools: true, vision: true, thinkingEffortSupported: false },
    }] })
    expect(models[0]).toMatchObject({
      id: 'cx/gpt-6-luna[1m]', contextWindow: 872000, maxOutputTokens: 128000,
      supportsReasoning: true, supportsTools: true, inputModalities: ['text', 'image'],
    })
  })

  it('reads nested capabilities and explicit effort lists ahead of family fallbacks', () => {
    expect(normalizeProviderModelMetadata({ data: [{
      id: 'cx/gpt-6.1-sol', capabilities: { contextWindow: 1050000, maxOutput: 128000 },
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    }] })[0]).toMatchObject({ contextWindow: 1050000, reasoningOptions: ['low', 'high'] })
  })

  it('keeps unknown limits unknown and distinguishes non-reasoning models', () => {
    expect(normalizeProviderModelMetadata({ data: [
      { id: 'cx/gpt-reserve', capabilities: { reasoning: false } },
      { id: 'unknown-model', context_length: -1 },
    ] })).toMatchObject([
      { id: 'cx/gpt-reserve', supportsReasoning: false, reasoningOptions: [] },
      { id: 'unknown-model', contextWindow: null, supportsReasoning: null },
    ])
  })
})
