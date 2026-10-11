import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FREE_MODE_DEFAULT_MODEL,
  createDefaultOpenRouterFreeModeState,
  getFreeKeyCount,
  getRandomFreeKey,
  getFreeModeConfigArgs,
  shouldMarkOpenRouterKeyAsCustom,
} from './freeMode'

describe('operator-supplied OpenRouter credentials only', () => {
  it('does not distribute a bundled credential pool', () => {
    expect(getFreeKeyCount()).toBe(0)
  })

  it('does not supply an implicit shared OpenRouter key', () => {
    expect(getRandomFreeKey()).toBeNull()
    expect(createDefaultOpenRouterFreeModeState()).toBeNull()
  })

  it('preserves operator-supplied OpenRouter credentials without a bundled pool', () => {
    const operatorKey = 'operator-fixture-not-a-provider-credential'
    const state = {
      enabled: true,
      apiKey: operatorKey,
      model: FREE_MODE_DEFAULT_MODEL,
      customKey: true,
      provider: 'openrouter' as const,
      wireApi: 'responses' as const,
    }
    const args = getFreeModeConfigArgs(state)
    expect(args).toContain('model_provider="openrouter_free"')
    expect(args).toContain(`model_providers.openrouter_free.experimental_bearer_token="${operatorKey}"`)
    expect(shouldMarkOpenRouterKeyAsCustom(state, '')).toBe(true)
    expect(state.apiKey).toBe(operatorKey)
    expect(getFreeKeyCount()).toBe(0)
  })

  it('does not retain credential-pool decoding material in source', () => {
    const source = readFileSync(new URL('./freeMode.ts', import.meta.url), 'utf8')
    const hasRecoverablePool = /ENCRYPTED_KEYS|DECRYPT_KEY|xorDecrypt/.test(source)
    expect(hasRecoverablePool).toBe(false)
  })
})
