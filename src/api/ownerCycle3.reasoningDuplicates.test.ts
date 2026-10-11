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
    const compiled = compileScript(descriptor, { id: 'owner-cycle3-reasoning-duplicates', inlineTemplate: true })
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

const exactId = 'duplicate-exact'
const affirmative = { id: exactId, model: exactId, supportedReasoningEfforts: efforts('max', 'ultra') }
const missing = { id: exactId, model: exactId }
const provider = {
  id: exactId, upstreamApi: 'responses', routingSource: 'provider-catalog', supportsTools: true,
  reasoningSource: 'provider-catalog', reasoningOptions: ['max', 'ultra'],
}
const restrictions = [
  { name: 'top-level false', declaration: { reasoning: false }, nonreasoning: true },
  { name: 'nested false', declaration: { capabilities: { reasoning: false } }, nonreasoning: true },
  { name: 'empty efforts', declaration: { supportedReasoningEfforts: [] } },
  { name: 'null efforts', declaration: { supportedReasoningEfforts: null } },
  { name: 'string efforts', declaration: { supportedReasoningEfforts: 'ultra' } },
  { name: 'object efforts', declaration: { supportedReasoningEfforts: {} } },
  { name: 'null effort item', declaration: { supportedReasoningEfforts: [null] } },
  { name: 'mixed malformed efforts', declaration: { supportedReasoningEfforts: [...efforts('max'), null] } },
  { name: 'unknown effort', declaration: { supportedReasoningEfforts: efforts('unknown') } },
  { name: 'numeric effort', declaration: { supportedReasoningEfforts: [{ reasoningEffort: 2 }] } },
]
const cases = restrictions.flatMap(restriction => [false, true].flatMap(restrictiveFirst => [false, true].map(otherAffirmative => ({ ...restriction, restrictiveFirst, otherAffirmative }))))

describe('PUB-ULTRA-01-REMAINING-REASONING-DUPLICATE actual catalog-to-composer seam', () => {
  it.each(cases)('retains every exact-ID restriction across both row orders and missing/affirmative peers: %j', async ({ declaration, nonreasoning, restrictiveFirst, otherAffirmative }) => {
    const restricted = { ...missing, ...declaration }
    const peer = otherAffirmative ? affirmative : missing
    const { ids, metadata, fetch } = await discover(restrictiveFirst ? [restricted, peer] : [peer, restricted], provider)
    expect(ids).toEqual([exactId])
    expect(metadata).toHaveLength(1)
    expect(metadata[0]).toMatchObject({ upstreamApi: 'responses', routingSource: 'provider-catalog', reasoningSource: 'provider-catalog', reasoningOptions: [], supportsTools: true })
    if (nonreasoning) expect(metadata[0]?.supportsReasoning).toBe(false)
    expect(capabilities.getModelReasoningEfforts(exactId, metadata[0])).toEqual([])
    const menus = await composerOptions(ids, metadata)
    expect(menus.get('Thinking')).toEqual([])
    // A reasoning-only restriction must not invent a wire/tool denial.
    expect(menus.get('Model')?.[0]?.disabled).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
  }, 15000)

  it.each([false, true].flatMap(withProvider => [
    { name: 'both affirmative', rows: [affirmative, affirmative], withProvider },
    { name: 'missing first', rows: [missing, affirmative], withProvider },
    { name: 'missing last', rows: [affirmative, missing], withProvider },
  ]))('never mints affirmative native evidence from duplicate declarations: %j', async ({ rows, withProvider }) => {
    const { ids, metadata } = await discover(rows, withProvider ? provider : undefined)
    expect(ids).toEqual([exactId])
    expect(metadata).toHaveLength(1)
    expect(metadata[0]?.reasoningOptions).toEqual([])
    if (!withProvider) expect(metadata[0]?.routingSource).toBe('unknown')
    expect((await composerOptions(ids, metadata)).get('Thinking')).toEqual([])
  })

  it.each([false, true].flatMap(withProvider => [false, true].map(duplicate => ({ withProvider, duplicate }))))('leaves all-missing native declarations unknown: %j', async ({ withProvider, duplicate }) => {
    const { ids, metadata } = await discover(duplicate ? [missing, missing] : [missing], withProvider ? provider : undefined)
    expect(metadata).toEqual(withProvider ? [provider] : [])
    const menus = await composerOptions(ids, metadata)
    if (withProvider) expect(menus.get('Thinking')?.map(option => option.value)).toEqual(['max', 'ultra'])
    else expect(menus.get('Thinking')?.map(option => option.value)).not.toContain('ultra')
  })

  it('keeps unique exact native Max and Ultra distinct and selectable without inventing wire/tools', async () => {
    const { ids, metadata } = await discover([affirmative])
    expect(metadata[0]).toMatchObject({ routingSource: 'codex-runtime-catalog', upstreamApi: 'unknown', supportsTools: null, reasoningOptions: ['max', 'ultra'] })
    const menus = await composerOptions(ids, metadata)
    expect(menus.get('Thinking')?.map(option => option.value)).toEqual(['max', 'ultra'])
    expect(menus.get('Model')?.[0]?.disabled).toBe(false)
  })

  it('preserves provider order and exact native intersection on the genuine unique route', async () => {
    const { ids, metadata } = await discover([affirmative], { ...provider, reasoningOptions: ['ultra', 'high', 'max'] })
    expect(capabilities.getModelReasoningEfforts(exactId, metadata[0])).toEqual(['ultra', 'max'])
    // The normalized provider list retains its order; the unchanged composer
    // deliberately renders efforts in its standard Max-before-Ultra order.
    expect((await composerOptions(ids, metadata)).get('Thinking')?.map(option => option.value)).toEqual(['max', 'ultra'])
  })

  it.each([{ supportsReasoning: false }, { reasoningOptions: [] }])('does not expand an explicit provider reasoning restriction: %j', async restriction => {
    const { ids, metadata } = await discover([affirmative], { ...provider, ...restriction })
    expect((await composerOptions(ids, metadata)).get('Thinking')).toEqual([])
  })

  it('does not grant unaudited cx Ultra from a raw unique native advertisement', async () => {
    const id = 'cx/gpt-6-astra-unreviewed-suffix'
    const { ids, metadata } = await discover([{ ...affirmative, id, model: id }])
    expect((await composerOptions(ids, metadata)).get('Thinking')?.map(option => option.value)).toEqual(['max'])
  })

  it('never joins a restriction from a different literal exact native ID', async () => {
    const { ids, metadata } = await discover([affirmative, { id: 'Duplicate-exact', model: 'Duplicate-exact', reasoning: false }], provider)
    expect(ids).toEqual([exactId, 'Duplicate-exact'])
    expect(capabilities.getModelReasoningEfforts(exactId, metadata[0])).toEqual(['max', 'ultra'])
    expect((await composerOptions(ids, metadata)).get('Thinking')?.map(option => option.value)).toEqual(['max', 'ultra'])
  })
})
