import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'
import { computed, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { getModelReasoningEfforts, isReasoningEffortSupported } from './modelCapabilities'
import { startThreadTurn } from '../api/codexGateway'
import type { ZenModelMetadata } from '../types/zenModels'

const composer = parse(readFileSync(new URL('../components/content/ThreadComposer.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content
const statements = ts.createSourceFile('Composer.ts', composer, ts.ScriptTarget.Latest, true).statements
const declarations = statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['modelMetadataById', 'reasoningOptions'].includes(d.name.getText())))
const desktop = ts.createSourceFile('Desktop.ts', readFileSync(new URL('../composables/useDesktopState.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let handler: ts.Node | undefined
function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'setSelectedReasoningEffort') handler = node; ts.forEachChild(node, visit) }
visit(desktop)
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
function frontend(metadata: Partial<ZenModelMetadata> | undefined) {
  const context = { props: { selectedModel: 'cx/gpt-6.1-sol', modelMetadata: metadata ? [{ id: 'cx/gpt-6.1-sol', ...metadata }] : [] }, computed, getModelReasoningEfforts }
  const options = vm.runInNewContext(compile(declarations.map(d => d.getText()).join('\n')) + '\nreasoningOptions.value', context)
  const selectedReasoningEffort = ref('high')
  const select = vm.runInNewContext(compile(handler!.getText(desktop)) + '\nsetSelectedReasoningEffort', {
    REASONING_EFFORT_OPTIONS: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    selectedThreadId: ref('fixture'), selectedModelId: ref('cx/gpt-6.1-sol'), selectedReasoningEffort,
    readModelIdForThread: () => 'cx/gpt-6.1-sol',
    isReasoningEffortSupported: (_id: string, effort: any) => isReasoningEffortSupported('cx/gpt-6.1-sol', effort, metadata),
  })
  return { options, select, selectedReasoningEffort }
}
afterEach(() => vi.unstubAllGlobals())
it('confirmed local metadata enables distinct Ultra in actual composer and guarded handler, forwarding literal Ultra to Codex', async () => {
  const h = frontend({ reasoningSource: 'codex-runtime-catalog', reasoningOptions: ['high', 'xhigh', 'max', 'ultra'] })
  expect(h.options.map((o: any) => o.value)).toEqual(['high', 'xhigh', 'max', 'ultra'])
  h.select('ultra')
  expect(h.selectedReasoningEffort.value).toBe('ultra')
  h.select('invalid')
  expect(h.selectedReasoningEffort.value).toBe('ultra')
  const requests: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ result: { turn: { id: 'no-generation-fixture' } } }), { status: 200 })
  }))
  await startThreadTurn('fixture-no-generation', 'fixture only', [], 'cx/gpt-6.1-sol', h.selectedReasoningEffort.value as any, undefined, [], 'default')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ method: 'turn/start', params: {
    model: 'cx/gpt-6.1-sol', effort: 'ultra', collaborationMode: { settings: { reasoning_effort: 'ultra' } },
  } })
})
it.each([undefined, { reasoningSource: 'provider-catalog' as const, reasoningOptions: [] }, { supportsReasoning: false, reasoningOptions: ['ultra'] }])('actual frontend handler rejects Ultra without confirmed permissive metadata %j', metadata => {
  const h = frontend(metadata)
  h.select('ultra')
  expect(h.selectedReasoningEffort.value).toBe('high')
  expect(h.options.map((o: any) => o.value)).not.toContain('ultra')
})
