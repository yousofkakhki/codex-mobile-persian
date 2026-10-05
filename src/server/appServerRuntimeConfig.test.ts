import { describe, expect, it } from 'vitest'
import { buildAppServerArgs } from './appServerRuntimeConfig'

describe('app-server runtime config', () => {
  it('passes an opt-in model catalog path to Codex without a global context override', () => {
    const previous = process.env.CODEXUI_MODEL_CATALOG_JSON
    process.env.CODEXUI_MODEL_CATALOG_JSON = '/home/test/catalog.json'
    try {
      const args = buildAppServerArgs()
      expect(args).toContain('model_catalog_json="/home/test/catalog.json"')
      expect(args.some(value => value.startsWith('model_context_window='))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CODEXUI_MODEL_CATALOG_JSON
      else process.env.CODEXUI_MODEL_CATALOG_JSON = previous
    }
  })

  it('enables Codex memories by default for spawned app-server processes', () => {
    const args = buildAppServerArgs()
    const featureIndex = args.indexOf('features.memories=true')

    expect(featureIndex).toBeGreaterThan(0)
    expect(args[featureIndex - 1]).toBe('-c')
  })

  it('can disable Codex memories through runtime configuration', () => {
    process.env.CODEXUI_MEMORIES = 'false'
    try {
      const args = buildAppServerArgs()
      const featureIndex = args.indexOf('features.memories=false')

      expect(featureIndex).toBeGreaterThan(0)
      expect(args[featureIndex - 1]).toBe('-c')
      expect(args).not.toContain('features.memories=true')
    } finally {
      delete process.env.CODEXUI_MEMORIES
    }
  })
})
