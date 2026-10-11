import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse, compileScript } from 'vue/compiler-sfc'
import { transformWithEsbuild } from 'vite'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { getAvailableModelIds } from '../api/codexGateway'
import * as capabilities from './modelCapabilities'
import type { ZenModelMetadata } from '../types/zenModels'

// Compile the unchanged actual SFC; collect the real dropdown's input options,
// not a fabricated implementation of its model/reasoning computed properties.
let compiledCode: string | undefined
async function composerOptions(models: string[], modelMetadata: ZenModelMetadata[]) {
  const filename = new URL('../components/content/ThreadComposer.vue', import.meta.url)
  if (!compiledCode) {
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname })
    const compiled = compileScript(descriptor, { id: 'publication-composer', inlineTemplate: true })
    compiledCode = (await transformWithEsbuild(compiled.content, filename.pathname + '.ts', { loader: 'ts', format: 'cjs' })).code
  }
  type Option = { value: string; disabled?: boolean; badge?: string; description?: string }
  const menus = new Map<string, Option[]>()
  const dropdown = Vue.defineComponent({
    props: ['options', 'placeholder', 'disabled', 'modelValue'],
    setup(props) {
      return () => {
        menus.set(String(props.placeholder), props.options ?? [])
        return Vue.h('div')
      }
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
  const module = { exports: {} as { default?: Vue.Component } }
  new Function('require', 'module', 'exports', compiledCode)(load, module, module.exports)
  await renderToString(Vue.createSSRApp(module.exports.default!, {
    activeThreadId: 'fixture', selectedCollaborationMode: 'default', models, modelMetadata,
    selectedModel: models[0], selectedReasoningEffort: 'max', selectedSpeedMode: 'standard',
  }))
  return menus
}
const rpc = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 })
afterEach(() => vi.unstubAllGlobals())

describe('PUB-ULTRA-01 native metadata in the actual composer', () => {
  it('keeps an exact native model selectable with distinct affirmed Max and Ultra choices', async () => {
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => rpc({ data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }] }] })))
    const models = await getAvailableModelIds({ includeProviderModels: false, onMetadata })
    const menus = await composerOptions(models, onMetadata.mock.calls.at(-1)?.[0])
    expect(menus.get('Model')?.find(option => option.value === 'gpt-6-astra')?.disabled).toBe(false)
    expect(menus.get('Thinking')?.map(option => option.value)).toEqual(['max', 'ultra'])
  }, 15000)
  it.each([{ supportsTools: false }, { capabilities: { tools: false } }])('retains explicit native tool restrictions: %j', async restriction => {
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => rpc({ data: [{ id: 'native-restricted-tools', model: 'native-restricted-tools', supportedReasoningEfforts: [{ reasoningEffort: 'max' }], ...restriction }] })))
    const models = await getAvailableModelIds({ includeProviderModels: false, onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(metadata[0]?.supportsTools).toBe(false)
    const menus = await composerOptions(models, metadata)
    expect(menus.get('Model')?.find(option => option.value === models[0])?.disabled).toBe(true)
  })
  it('preserves missing reasoning as unknown while honoring a native tools-only restriction', async () => {
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => rpc({ data: [{ id: 'native-tools-only', model: 'native-tools-only', supportsTools: false }] })))
    const models = await getAvailableModelIds({ includeProviderModels: false, onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(metadata[0]?.supportsTools).toBe(false)
    expect(metadata[0]?.reasoningSource).toBeUndefined()
    const menus = await composerOptions(models, metadata)
    expect(menus.get('Model')?.find(option => option.value === models[0])?.disabled).toBe(true)
    expect(menus.get('Thinking')?.map(option => option.value)).toContain('max')
    expect(menus.get('Thinking')?.map(option => option.value)).not.toContain('ultra')
  })
  it('never accepts a provider-advertised executor provenance tag as a native route affirmation', async () => {
    const provider = { id: 'provider-tag', upstreamApi: 'unknown', routingSource: 'codex-runtime-catalog', reasoningSource: 'provider-catalog', reasoningOptions: ['max'], supportsTools: true }
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [provider.id], models: [provider], exclusive: true }), { status: 200 })))
    const models = await getAvailableModelIds({ providerId: 'custom', onMetadata })
    const menus = await composerOptions(models, onMetadata.mock.calls.at(-1)?.[0])
    expect(menus.get('Model')?.find(option => option.value === provider.id)?.disabled).toBe(true)
  })
  it.each([[], [null]].map(value => [value]))('does not conflate restrictive or malformed native effort data with missing metadata: %j', async supportedReasoningEfforts => {
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => rpc({ data: [{ id: 'native-limit', model: 'native-limit', supportedReasoningEfforts }] })))
    const models = await getAvailableModelIds({ includeProviderModels: false, onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    const menus = await composerOptions(models, metadata)
    expect(menus.get('Thinking')).toEqual([])
    expect(menus.get('Model')?.find(option => option.value === models[0])?.disabled).toBe(supportedReasoningEfforts.length > 0)
  })
  it('retains missing native metadata as unknown reasoning rather than granting Ultra', async () => {
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => rpc({ data: [{ id: 'native-missing', model: 'native-missing' }] })))
    const models = await getAvailableModelIds({ includeProviderModels: false, onMetadata })
    const metadata = onMetadata.mock.calls.at(-1)?.[0] as ZenModelMetadata[]
    expect(metadata).toEqual([])
    const menus = await composerOptions(models, metadata)
    expect(menus.get('Model')?.find(option => option.value === models[0])?.disabled).toBe(false)
    expect(menus.get('Thinking')?.map(option => option.value)).not.toContain('ultra')
  })
  it('never exempts an unsupported provider route just because its reasoning is native-confirmed', async () => {
    const provider = { id: 'cx/gpt-6.1-sol', upstreamApi: 'unknown', routingSource: 'provider-catalog', reasoningSource: 'codex-runtime-catalog', reasoningOptions: ['max', 'ultra'], supportsTools: true }
    const onMetadata = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [provider.id], models: [provider], exclusive: true }), { status: 200 })))
    const models = await getAvailableModelIds({ providerId: 'custom', onMetadata })
    const menus = await composerOptions(models, onMetadata.mock.calls.at(-1)?.[0])
    expect(menus.get('Model')?.find(option => option.value === provider.id)?.disabled).toBe(true)
  })
})
