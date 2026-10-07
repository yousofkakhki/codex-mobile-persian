import { describe, expect, it } from 'vitest'
import {
  getFastModeCreditMultiplier,
  isFastModeSupported,
  isReasoningEffortSupported,
  isUltraReasoningModel,
  normalizeModelIdForProvider,
} from './modelCapabilities'

describe('model capabilities', () => {
  it('keeps measured context authoritative and labels next-turn configuration separately', async () => {
    const api = await import('./modelCapabilities')
    expect(api.resolveModelContextWindow, 'context resolver must exist').toBeTypeOf('function')
    expect(api.resolveModelContextWindow(272000, 1050000)).toBe(272000)
    expect(api.resolveModelContextWindow(null, 872000)).toBe(872000)
    expect(api.resolveModelContextWindow(-1, 872000)).toBe(872000)
    expect(api.resolveModelContextWindow(null, Infinity)).toBeNull()
    expect(api.resolveModelContextWindow(1.5, -1)).toBeNull()
    expect(api.getContextWindowStatus(258400, { configuredContextWindow: 997500, contextWindow: 1050000 })).toEqual({
      measuredWindow: 258400, configuredWindow: 997500, differs: true,
    })
    expect(api.getContextWindowStatus(997500, { configuredContextWindow: 997500 }).differs).toBe(false)
    expect(api.getContextWindowStatus(258400, { contextWindow: 1050000 }).differs).toBe(false)
  })

  it('recognizes extended-context Astra and 6.1 Fast aliases without broadening unrelated models', () => {
    expect(isUltraReasoningModel('cx/gpt-6-astra[1m]')).toBe(true)
    expect(isFastModeSupported('cx/gpt-6.1-sol')).toBe(true)
    expect(isFastModeSupported('cx/gpt-6-luna[1m]')).toBe(true)
    expect(isUltraReasoningModel('cx/gpt-6.1-sol')).toBe(false)
    expect(isFastModeSupported('gpt-7-unknown')).toBe(false)
  })

  it('restricts reasoning to explicit provider choices including an authoritative empty list', async () => {
    const api = await import('./modelCapabilities')
    expect(api.getModelReasoningEfforts, 'metadata reasoning validation must exist').toBeTypeOf('function')
    expect(api.getModelReasoningEfforts('cx/gpt-6.1-sol', { reasoningOptions: ['low', 'high', 'max', 'high', 'invalid'] })).toEqual(['low', 'high', 'max'])
    expect(api.getModelReasoningEfforts('cx/gpt-reserve', { supportsReasoning: false })).toEqual([])
    expect(api.getModelReasoningEfforts('cx/gpt-6-astra', { reasoningOptions: [], reasoningSource: 'provider-catalog' })).toEqual([])
    expect(api.getModelReasoningEfforts('sdk-model', { reasoningOptions: [], routingSource: 'sdk-metadata' })).toContain('medium')
    expect(api.getModelReasoningEfforts('unknown', { reasoningOptions: [], routingSource: 'provider-catalog' })).toContain('medium')
    expect(api.getModelReasoningEfforts('non-astra', { reasoningOptions: ['ultra'], reasoningSource: 'provider-catalog' })).toEqual(['ultra'])
    expect(api.isReasoningEffortSupported('cx/gpt-6.1-sol', 'none', { reasoningOptions: ['low', 'max'] })).toBe(false)
    expect(api.isReasoningEffortSupported('cx/gpt-reserve', '', { supportsReasoning: false })).toBe(true)
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

describe('composer metadata rendering', () => {
  let compiledCode: string | undefined
  async function renderComposer(overrides: Record<string, unknown> = {}) {
    const { readFileSync } = await import('node:fs')
    const { createRequire } = await import('node:module')
    const { parse, compileScript } = await import('vue/compiler-sfc')
    const { transformWithEsbuild } = await import('vite')
    const Vue = await import('vue')
    const { renderToString } = await import('vue/server-renderer')
    const capabilities = await import('./modelCapabilities')
    const filename = new URL('../components/content/ThreadComposer.vue', import.meta.url)
    if (!compiledCode) {
      const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname })
      const compiled = compileScript(descriptor, { id: 'metadata-composer-unit', inlineTemplate: true })
      compiledCode = (await transformWithEsbuild(compiled.content, filename.pathname + '.ts', { loader: 'ts', format: 'cjs' })).code
    }
    const code = compiledCode
    const dropdown = Vue.defineComponent({
      props: ['options', 'placeholder', 'disabled', 'modelValue'],
      setup(props) {
        return () => Vue.h('div', { 'data-menu': props.placeholder, 'data-disabled': String(props.disabled) },
          (props.options ?? []).map((option: { value: string; description?: string }) => Vue.h('span', { 'data-option': option.value }, option.description ?? option.value)))
      },
    })
    const inert = Vue.defineComponent({ setup: () => () => null })
    const nativeRequire = createRequire(import.meta.url)
    const load = (id: string): unknown => {
      if (id === 'vue') return Vue
      if (id.includes('modelCapabilities')) return capabilities
      if (id.endsWith('ComposerDropdown.vue')) return dropdown
      if (id.endsWith('.vue')) return inert
      if (id.includes('useUiLanguage')) return { useUiLanguage: () => ({ t: (text: string) => text }) }
      if (id.includes('useMobile')) return { useMobile: () => ({ isMobile: Vue.ref(false) }) }
      if (id.includes('useRpcTelemetry')) return { useRpcTelemetry: () => ({ rpcTelemetry: Vue.ref({ connectionState: 'offline' }) }) }
      if (id.includes('useDictation')) return { useDictation: () => ({ state: Vue.ref('idle'), isSupported: Vue.ref(false), recordingDurationMs: Vue.ref(0), waveformCanvasRef: Vue.ref(null), cancel: () => undefined }) }
      if (id.includes('codexGateway')) return {}
      if (id.includes('composerSlashMentions')) return { filterComposerSlashSuggestions: () => [] }
      return nativeRequire(id)
    }
    const module = { exports: {} as { default?: import('vue').Component } }
    new Function('require', 'module', 'exports', code)(load, module, module.exports)
    const props = {
      activeThreadId: 'fixture', selectedCollaborationMode: 'default', models: ['cx/gpt-6.1-sol'],
      selectedModel: 'cx/gpt-6.1-sol', selectedReasoningEffort: 'max', selectedSpeedMode: 'standard',
      modelMetadata: [{ id: 'cx/gpt-6.1-sol', contextWindow: 1050000, maxOutputTokens: 128000, configuredContextWindow: 997500,
        upstreamApi: 'responses', routingSource: 'provider-catalog', supportsTools: true, supportsReasoning: true,
        reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningSource: 'provider-catalog' }],
      ...overrides,
    }
    return renderToString(Vue.createSSRApp(module.exports.default!, props))
  }

  it('renders only supported Thinking choices and disables non-reasoning selection', async () => {
    const html = await renderComposer()
    const thinking = html.match(/<div data-menu="Thinking"[^>]*>(.*?)<\/div>/s)?.[0] ?? ''
    expect(thinking).toContain('data-option="max"')
    expect(thinking).not.toContain('data-option="none"')
    expect(thinking).not.toContain('data-option="minimal"')
    expect(thinking).not.toContain('data-option="ultra"')
    const disabled = await renderComposer({ modelMetadata: [{ id: 'cx/gpt-6.1-sol', supportsReasoning: false }] })
    expect(disabled).toContain('data-menu="Thinking" data-disabled="true"')
  }, 15000)

  it('discloses provider limits without misrepresenting family fallback as provider-declared reasoning', async () => {
    const html = await renderComposer({ modelMetadata: [{ id: 'cx/gpt-6.1-sol', contextWindow: 1050000, maxOutputTokens: 128000,
      upstreamApi: 'responses', routingSource: 'provider-catalog', supportsTools: true,
      reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningSource: 'codex-family-fallback' }] })
    expect(html).toContain('Provider advertised')
    expect(html).toContain('1,050,000 context tokens')
    expect(html).toContain('128,000 max output')
    expect(html).toContain('Reasoning: Codex-family fallback, not provider-declared')
    const sdk = await renderComposer({ modelMetadata: [{ id: 'cx/gpt-6.1-sol', upstreamApi: 'chat-completions', routingSource: 'sdk-metadata' }] })
    expect(sdk).toContain('SDK-inferred, not access-tested')
  })

  it('renders historical runtime capacity separately from configuration and advertised estimates', async () => {
    const usage = { modelContextWindow: 258400, currentContextTokens: 20000,
      last: { totalTokens: 20000, inputTokens: 15000, outputTokens: 5000, cachedInputTokens: 0, reasoningOutputTokens: 0 },
      total: { totalTokens: 20000, inputTokens: 15000, outputTokens: 5000, cachedInputTokens: 0, reasoningOutputTokens: 0 } }
    const html = await renderComposer({ threadTokenUsage: usage })
    expect(html).toContain('Last turn 20k / 258k · Next 998k')
    expect(html).toContain('runtime limit remains authoritative')
    expect(html).toContain('previous-turn measurement or a per-thread override')
    const updated = await renderComposer({ threadTokenUsage: { ...usage, modelContextWindow: 997500 } })
    expect(updated).not.toContain('Last turn 20k / 258k · Next')
    const estimated = await renderComposer({ threadTokenUsage: { ...usage, modelContextWindow: null } })
    expect(estimated).toContain('Provider-advertised estimate; runtime context limit is unknown')
    expect(estimated).toContain('/ 1.1M')
  })

  it('indexes provider metadata once rather than searching every row for every menu option', async () => {
    let reads = 0
    const models = Array.from({ length: 300 }, (_, i) => `model-${i}`)
    const modelMetadata = models.map(id => ({
      get id() { reads++; return id }, upstreamApi: 'responses', routingSource: 'provider-catalog',
    }))
    const html = await renderComposer({ models, modelMetadata, selectedModel: models[0] })
    expect(html).toContain('data-option="model-299"')
    expect(reads, 'metadata key reads must scale linearly').toBe(600)
  })
})
