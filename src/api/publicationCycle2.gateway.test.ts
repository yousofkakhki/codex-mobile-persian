import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse, compileScript } from 'vue/compiler-sfc'
import { transformWithEsbuild } from 'vite'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { getAvailableModelIds } from './codexGateway'
import * as capabilities from '../utils/modelCapabilities'
import type { ZenModelMetadata } from '../types/zenModels'

// Compile the real, unchanged composer and observe its actual dropdown props.
let compiledCode: string | undefined
async function composerOptions(models: string[], modelMetadata: ZenModelMetadata[]) {
  const filename = new URL('../components/content/ThreadComposer.vue', import.meta.url)
  if (!compiledCode) {
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname })
    const compiled = compileScript(descriptor, { id: 'publication-cycle2-composer', inlineTemplate: true })
    compiledCode = (await transformWithEsbuild(compiled.content, filename.pathname + '.ts', { loader: 'ts', format: 'cjs' })).code
  }
  type Option = { value: string; disabled?: boolean }
  const menus = new Map<string, Option[]>()
  const dropdown = Vue.defineComponent({
    props: ['options', 'placeholder', 'disabled', 'modelValue'],
    setup(props) { return () => { menus.set(String(props.placeholder), props.options ?? []); return Vue.h('div') } },
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
const efforts = (...values: string[]) => values.map(reasoningEffort => ({ reasoningEffort }))
async function discover(native: unknown[], provider?: Record<string, unknown>) {
  const onMetadata = vi.fn<(metadata: ZenModelMetadata[]) => void>()
  const fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes('provider-models')
    ? new Response(JSON.stringify({ data: provider ? [provider.id] : [], models: provider ? [provider] : [] }), { status: 200 })
    : rpc({ data: native, nextCursor: null }))
  vi.stubGlobal('fetch', fetch)
  const ids = await getAvailableModelIds({ includeProviderModels: !!provider, providerId: 'custom', onMetadata })
  return { ids, metadata: onMetadata.mock.calls.at(-1)![0], fetch }
}
afterEach(() => vi.unstubAllGlobals())

describe('PUB-ULTRA-01-REMAINING-TOOLS-DUPLICATE exact catalog-to-composer path', () => {
  it.each([
    { restriction: { supportsTools: false }, restrictiveFirst: false },
    { restriction: { supportsTools: false }, restrictiveFirst: true },
    { restriction: { capabilities: { tools: false } }, restrictiveFirst: false },
    { restriction: { capabilities: { tools: false } }, restrictiveFirst: true },
  ])('honors every duplicate native tool restriction despite affirmative provider metadata: %j', async ({ restriction, restrictiveFirst }) => {
    const base = { id: 'dup-native', model: 'dup-native', supportedReasoningEfforts: efforts('max', 'ultra') }
    const restricted = { ...base, ...restriction }
    const { ids, metadata, fetch } = await discover(restrictiveFirst ? [restricted, base] : [base, restricted], {
      id: base.id, upstreamApi: 'responses', routingSource: 'provider-catalog', supportsTools: true,
      reasoningSource: 'provider-catalog', reasoningOptions: ['max', 'ultra'],
    })
    const menus = await composerOptions(ids, metadata)
    expect(ids).toEqual(['dup-native'])
    expect(metadata).toHaveLength(1)
    expect(metadata[0]).toMatchObject({ supportsTools: false, upstreamApi: 'responses', routingSource: 'provider-catalog', reasoningOptions: [] })
    expect(menus.get('Thinking')).toEqual([])
    expect(menus.get('Model')?.[0]?.disabled).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  }, 15000)
  it('retains a later tools-only restriction when the first duplicate has native efforts', async () => {
    const { ids, metadata } = await discover([
      { id: 'dup-native', model: 'dup-native', supportedReasoningEfforts: efforts('max', 'ultra') },
      { id: 'dup-native', model: 'dup-native', capabilities: { tools: false } },
    ], { id: 'dup-native', upstreamApi: 'responses', routingSource: 'provider-catalog', supportsTools: true, reasoningSource: 'provider-catalog', reasoningOptions: ['max', 'ultra'] })
    expect(metadata[0]?.supportsTools).toBe(false)
    expect((await composerOptions(ids, metadata)).get('Model')?.[0]?.disabled).toBe(true)
  })
  it('keeps genuine unique native executor provenance selectable without inventing wire or tool support', async () => {
    const { ids, metadata, fetch } = await discover([{ id: 'native-exact', model: 'native-exact', supportedReasoningEfforts: efforts('max', 'ultra') }])
    expect(metadata[0]).toMatchObject({ id: 'native-exact', upstreamApi: 'unknown', routingSource: 'codex-runtime-catalog', supportsTools: null })
    const menus = await composerOptions(ids, metadata)
    expect(menus.get('Model')?.[0]?.disabled).toBe(false)
    expect(menus.get('Thinking')?.map(option => option.value)).toEqual(['max', 'ultra'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves unique-model exact effort intersection, provider order, and explicit provider restrictions', async () => {
    const { ids, metadata } = await discover([{ id: 'native-exact', model: 'native-exact', supportedReasoningEfforts: efforts('low', 'max', 'ultra') }], {
      id: 'native-exact', upstreamApi: 'responses', routingSource: 'provider-catalog', supportsTools: true,
      reasoningSource: 'provider-catalog', reasoningOptions: ['ultra', 'high', 'max'],
    })
    expect(capabilities.getModelReasoningEfforts(ids[0]!, metadata[0])).toEqual(['ultra', 'max'])
    expect((await composerOptions(ids, metadata)).get('Model')?.[0]?.disabled).toBe(false)
    const restricted = await discover([{ id: 'native-exact', model: 'native-exact', supportedReasoningEfforts: efforts('max', 'ultra') }], {
      id: 'native-exact', upstreamApi: 'responses', routingSource: 'provider-catalog', supportsTools: false,
      reasoningSource: 'provider-catalog', reasoningOptions: [],
    })
    expect(capabilities.getModelReasoningEfforts('native-exact', restricted.metadata[0])).toEqual([])
    expect((await composerOptions(restricted.ids, restricted.metadata)).get('Model')?.[0]?.disabled).toBe(true)
  })
  it.each([128, 512, 2048])('normalizes %i unique native models plus a final restrictive duplicate with one catalog RPC', async count => {
    const native = Array.from({ length: count }, (_, index) => ({ id: `native-${index}`, model: `native-${index}`, supportedReasoningEfforts: efforts('max', 'ultra') }))
    const start = performance.now()
    const { ids, metadata, fetch } = await discover([...native, { id: 'native-0', model: 'native-0', supportsTools: false }])
    const elapsedMs = performance.now() - start
    expect(ids).toHaveLength(count)
    expect(metadata).toHaveLength(count)
    expect(metadata[0]?.supportsTools).toBe(false)
    expect(metadata.at(-1)?.routingSource).toBe('codex-runtime-catalog')
    expect(fetch).toHaveBeenCalledTimes(1)
    console.info('publicationCycle2 catalog measurement', JSON.stringify({ nativeRows: count + 1, uniqueModels: count, catalogRequests: fetch.mock.calls.length, elapsedMs }))
  })
})
