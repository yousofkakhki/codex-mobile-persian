import { describe, expect, it } from 'vitest'
import { getConfiguredContextWindows } from './runtimeModelCatalog'

describe('configured runtime model windows', () => {
  it('reads exact catalog aliases and applies Codex effective context percentage', () => {
    expect(getConfiguredContextWindows({ models: [
      { slug: 'cx/gpt-6.1-sol', context_window: 1050000 },
      { slug: 'cx/gpt-6-sol[1m]', context_window: 872000, effective_context_window_percent: 95 },
      { slug: 'cx/unknown', context_window: -1 },
    ] })).toEqual({ 'cx/gpt-6.1-sol': 997500, 'cx/gpt-6-sol[1m]': 828400 })
  })

  it('honors explicit percentages and context overrides without exceeding model maximum', () => {
    expect(getConfiguredContextWindows({ models: [
      { slug: 'model', context_window: 200000, max_context_window: 300000, effective_context_window_percent: 90 },
    ] }, 500000)).toEqual({ model: 270000 })
    expect(getConfiguredContextWindows(null)).toEqual({})
  })
})
