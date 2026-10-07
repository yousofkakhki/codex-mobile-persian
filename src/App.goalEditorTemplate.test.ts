import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// Compile the actual whole conditional editor, not an invented numeric-input fixture.
// Execute its original declarations/open/save handlers; only external authorization/RPCs are fixtures.
const app = readFileSync(new URL('./App.vue', import.meta.url), 'utf8')
const sfc = parse(app).descriptor
const template = sfc.template!.content.match(/<section v-if="isGoalEditorOpen"[\s\S]*?<\/section>/)![0]
const ast = ts.createSourceFile('App.ts', sfc.scriptSetup!.content, ts.ScriptTarget.Latest, true)
const names = new Set(['goalStatusOptions', 'threadGoalState', 'selectedThreadGoal', 'isGoalEditorOpen',
  'isSavingThreadGoal', 'isLoadingThreadGoal', 'goalEditorContextVersion', 'goalEditorObjective',
  'goalEditorStatus', 'goalEditorTokenBudget', 'goalEditorError', 'goalBudgetOwnerAuthorized',
  'isGoalBudgetEditorOpen', 'goalBudgetAuditStatus', 'isGoalBudgetAdjustment'])
const functions = new Set(['formatGoalStatus', 'openGoalEditor', 'onSaveThreadGoal', 'onClearThreadGoal'])
const originalDeclarations = ast.statements.filter(statement =>
  ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => names.has(declaration.name.getText(ast)))
  || ts.isFunctionDeclaration(statement) && functions.has(statement.name!.text)
  || ts.isExpressionStatement(statement) && statement.getText(ast).startsWith('watch([selectedThreadId, isHomeRoute]'),
).map(statement => statement.getText(ast)).join('\n')
const declarations = ts.transpileModule(originalDeclarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const bindings = [...names, ...functions].join(',')
const recoveryGoal = { threadId: 'owned', objective: 'Keep existing objective', status: 'budgetLimited',
  tokenBudget: 100000, tokensUsed: 117527, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 }
type Options = { goal?: typeof recoveryGoal | null; owner?: boolean; confirm?: boolean; deferredAuth?: boolean }

function fixtureSource(options: Options) {
  return `
  const selectedThreadId = ref('owned'), isHomeRoute = ref(false);
  const calls = { save: [], resume: [], confirms: [] };
  let completeAuthorization;
  const authorization = ${options.deferredAuth ? 'new Promise(resolve => { completeAuthorization = resolve })' : JSON.stringify(options.owner ?? true)};
  const getGoalBudgetOwnerAuthorization = async () => authorization;
  const useThreadGoalState = () => ({
    goal: ref(${JSON.stringify(options.goal ?? null)}), loaded: ref(true), saving: ref(false), loading: ref(false), error: ref(''),
    refresh: async () => {}, clear: async () => false,
    save: async input => { calls.save.push({ threadId: selectedThreadId.value, ...input }); return true },
    resume: async (budget, confirmed) => { calls.resume.push({ threadId: selectedThreadId.value, budget, confirmed }); return true }
  });
  ${declarations}
  globalThis.fixture = { calls, open: openGoalEditor, save: onSaveThreadGoal,
    finishAuth: value => completeAuthorization(value),
    select: id => { selectedThreadId.value = id },
    goHome: () => { isHomeRoute.value = true },
    snapshot: () => ({ budget: goalEditorTokenBudget.value, error: goalEditorError.value,
      authorized: goalBudgetOwnerAuthorized.value, open: isGoalEditorOpen.value,
      goal: selectedThreadGoal.value, calls }) };
  globalThis.editorBindings = { ${bindings} };
  `
}

// Also preserves the reviewer's exact installed-Vue SSR failure seam without a browser shim.
it('actual owner/no-Goal conditional budget block renders after the original open declaration', async () => {
  const state = vm.createContext({ ...Vue, globalThis: undefined })
  // The VM's own global is used by the original-declaration fixture.
  delete state.globalThis
  vm.runInContext(fixtureSource({}), state)
  await state.fixture.open()
  const html = await renderToString(Vue.createSSRApp({ setup: () => state.editorBindings, render: Vue.compile(template) }))
  expect(state.fixture.snapshot().budget).toBe('')
  expect(html).toContain('id="goal-total-budget"')
  expect(html).toContain('greater than 0 consumed tokens')
})

describe('actual Goal editor template in installed Vue and Chromium, no API/provider traffic', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let escapedRequests: string[]
  let pageErrors: string[]
  beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] }) })
  afterEach(async () => {
    await context?.close()
    expect(escapedRequests).toEqual([])
    expect(pageErrors).toEqual([])
    expect((await browser.contexts()).length).toBe(0)
  })
  afterAll(async () => { await browser?.close() })
  async function mount(options: Options = {}, adjust = false) {
    escapedRequests = []
    pageErrors = []
    context = await browser.newContext()
    await context.route('**/*', route => { escapedRequests.push(route.request().url()); return route.abort() })
    page = await context.newPage()
    page.setDefaultTimeout(2000)
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
    await page.setContent('<div id="editor"></div>')
    await page.addScriptTag({ content: readFileSync(new URL('../node_modules/vue/dist/vue.global.js', import.meta.url), 'utf8') })
    await page.addScriptTag({ content: `
      const { ref, computed, watch, createApp, compile } = Vue;
      window.fetch = () => Promise.reject(new Error('Network prohibited in Goal template regression'));
      window.confirm = message => { fixture.calls.confirms.push(message); return ${options.confirm ?? true} };
      ${fixtureSource(options)}
      createApp({ setup: () => editorBindings, render: compile(${JSON.stringify(template)}) }).mount('#editor');
    ` })
    await page.evaluate(({ adjust, deferred }) => {
      const opening = (window as any).fixture.open(adjust)
      return deferred ? undefined : opening
    }, { adjust, deferred: options.deferredAuth ?? false })
    return page
  }
  const snapshot = () => page.evaluate(() => (window as any).fixture.snapshot())
  const save = () => page.getByRole('button', { name: 'Save goal', exact: true }).click()

  it('renders a blank numeric total with zero-consumed help and creates only after explicit confirmation', async () => {
    await mount()
    const input = page.getByLabel('Total token budget')
    expect(await input.count()).toBe(1)
    expect(await input.inputValue()).toBe('')
    expect(await input.getAttribute('type')).toBe('number')
    expect(await page.locator('#goal-total-budget-help').innerText()).toContain('greater than 0 consumed tokens')
    await page.getByLabel('Goal objective').fill('New finite Goal')
    await save()
    expect((await snapshot()).calls.save).toEqual([])
    expect((await snapshot()).calls.confirms).toEqual([])
    await input.fill('200000')
    expect((await snapshot()).budget).toBe(200000) // Real Vue numeric v-model coercion.
    await save()
    const result = await snapshot()
    expect(result.calls.save).toEqual([{ threadId: 'owned', objective: 'New finite Goal', status: 'active', tokenBudget: 200000, ownerConfirmed: true }])
    expect(result.calls.confirms).toHaveLength(1)
    expect(result.calls.confirms[0]).toContain('for this new Goal')
    expect(result.calls.confirms[0]).toContain('0 consumed tokens')
  })

  it('does not send a new Goal when owner confirmation is cancelled', async () => {
    await mount({ confirm: false })
    await page.getByLabel('Goal objective').fill('New finite Goal')
    await page.getByLabel('Total token budget').fill('200000')
    await save()
    const result = await snapshot()
    expect(result.calls.save).toEqual([])
    expect(result.calls.confirms).toHaveLength(1)
    expect(result.open).toBe(true)
  })

  it('cancels the actual editor without a new Goal request', async () => {
    await mount()
    await page.getByLabel('Goal objective').fill('Not saved')
    await page.getByLabel('Total token budget').fill('200000')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    const result = await snapshot()
    expect(result.open).toBe(false)
    expect(result.calls.save).toEqual([])
    expect(result.calls.confirms).toEqual([])
  })

  it('hides numeric controls for a nonowner and never sends a new Goal', async () => {
    await mount({ owner: false })
    expect(await page.locator('#goal-total-budget').count()).toBe(0)
    await page.getByLabel('Goal objective').fill('Denied new Goal')
    await save()
    expect((await snapshot()).calls.save).toEqual([])
    expect((await snapshot()).calls.confirms).toEqual([])
  })

  it.each(['', '0', '-1', '1.5', '9007199254740992', '1e309'])('rejects new Goal total %j without confirmation or mutation', async total => {
    await mount()
    await page.getByLabel('Goal objective').fill('New finite Goal')
    await page.getByLabel('Total token budget').fill(total)
    await save()
    const result = await snapshot()
    expect(result.error).toContain('finite integer')
    expect(result.calls.save).toEqual([])
    expect(result.calls.confirms).toEqual([])
  })

  it('requires an objective even after explicit positive total input', async () => {
    await mount()
    await page.getByLabel('Total token budget').fill('200000')
    expect(await page.getByRole('button', { name: 'Save goal', exact: true }).isDisabled()).toBe(true)
    expect((await snapshot()).calls.save).toEqual([])
  })

  it('keeps ordinary existing-objective edits budget-free and confirmation-free', async () => {
    await mount({ goal: { ...recoveryGoal, status: 'paused', tokensUsed: 7 } })
    expect(await page.locator('#goal-total-budget').count()).toBe(0)
    await page.getByLabel('Goal objective').fill('Edited existing objective')
    await save()
    const result = await snapshot()
    expect(result.calls.save).toEqual([{ threadId: 'owned', objective: 'Edited existing objective', status: 'paused' }])
    expect(result.calls.confirms).toEqual([])
  })

  it('keeps exhausted recovery rendered, budget-only, and accounting-preserving', async () => {
    await mount({ goal: recoveryGoal }, true)
    expect(await page.getByLabel('Total token budget').inputValue()).toBe('100000')
    expect(await page.locator('#goal-total-budget-help').innerText()).toContain('117,527 consumed tokens')
    await page.getByLabel('Goal objective').fill('')
    await page.getByLabel('Total token budget').fill('200000')
    await save()
    const result = await snapshot()
    expect(result.calls.resume).toEqual([{ threadId: 'owned', budget: 200000, confirmed: true }])
    expect(result.calls.save).toEqual([])
    expect(result.goal).toEqual(recoveryGoal)
  })

  it.each(['select', 'home'])('discards a late owner authorization after context changes to %s', async transition => {
    await mount({ deferredAuth: true })
    await page.evaluate(transition => {
      const f = (window as any).fixture
      if (transition === 'select') f.select('another-thread'); else f.goHome()
      f.finishAuth(true)
    }, transition)
    await page.waitForTimeout(0)
    expect(await page.locator('#goal-total-budget').count()).toBe(0)
    expect((await snapshot()).authorized).toBe(false)
    expect((await snapshot()).calls.save).toEqual([])
  })
})
