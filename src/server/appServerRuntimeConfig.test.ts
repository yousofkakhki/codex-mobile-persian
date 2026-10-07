import { describe, expect, it } from 'vitest'
import { buildAppServerArgs } from './appServerRuntimeConfig'

describe('app-server runtime config', () => {
  it('explicit multi-agent v2 opt-in appends only its supported config override', () => {
    const keys = ['CODEXUI_MULTI_AGENT_V2', 'CODEXUI_MODEL_CATALOG_JSON', 'CODEXUI_SANDBOX_MODE', 'CODEXUI_APPROVAL_POLICY', 'CODEXUI_MEMORIES'] as const
    const previous = keys.map(key => process.env[key])
    try {
      process.env.CODEXUI_MODEL_CATALOG_JSON = '/synthetic/reviewed-catalog.json'
      process.env.CODEXUI_SANDBOX_MODE = 'read-only'
      process.env.CODEXUI_APPROVAL_POLICY = 'on-request'
      process.env.CODEXUI_MEMORIES = 'false'
      delete process.env.CODEXUI_MULTI_AGENT_V2
      const baseline = buildAppServerArgs()
      expect(baseline).toContain('approval_policy="on-request"')
      expect(baseline).toContain('sandbox_mode="read-only"')
      expect(baseline).toContain('features.memories=false')
      expect(baseline.some(arg => arg.startsWith('features.multi_agent_v2='))).toBe(false)
      process.env.CODEXUI_MULTI_AGENT_V2 = 'true'
      expect(buildAppServerArgs()).toEqual([...baseline, '-c', 'features.multi_agent_v2=true'])
      expect(buildAppServerArgs().some(arg => /^(model_provider|model_context_window|model_auto_compact_token_limit)=/.test(arg))).toBe(false)
      for (const value of ['', 'false', '0', '1', 'yes', 'invalid']) {
        process.env.CODEXUI_MULTI_AGENT_V2 = value
        expect(buildAppServerArgs()).toEqual(baseline)
      }
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      })
    }
  })


  it('passes an opt-in quoted catalog path without changing provider or global context policy', () => {
    const previous = process.env.CODEXUI_MODEL_CATALOG_JSON
    process.env.CODEXUI_MODEL_CATALOG_JSON = '  /synthetic/catalog "quoted".json  '
    try {
      const args = buildAppServerArgs()
      const index = args.indexOf(`model_catalog_json=${JSON.stringify('/synthetic/catalog "quoted".json')}`)
      expect(index).toBeGreaterThan(0)
      expect(args[index - 1]).toBe('-c')
      expect(args.some(value => /^(model_provider|model_context_window|model_auto_compact_token_limit)=/.test(value))).toBe(false)
      process.env.CODEXUI_MODEL_CATALOG_JSON = '   '
      expect(buildAppServerArgs().some(value => value.startsWith('model_catalog_json='))).toBe(false)
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
