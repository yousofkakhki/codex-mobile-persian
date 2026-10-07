import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'
import { computed, ref, vModelText } from 'vue'
import { describe, expect, it, vi } from 'vitest'

// Execute the original handler and template expression from App.vue; do not duplicate their semantics.
const app = readFileSync(new URL('./App.vue', import.meta.url), 'utf8')
const sfc = parse(app).descriptor
const script = ts.createSourceFile('App.ts', sfc.scriptSetup!.content, ts.ScriptTarget.Latest, true)
const handler = script.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'onSaveThreadGoal')!
const compiledHandler = ts.transpileModule(handler.getText(script), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const budgetInput = sfc.template!.content.match(/<input\s[^>]*id="goal-total-budget"[^>]*>/)![0]
const saveButton = sfc.template!.content.match(/<button\s[^>]*@click="onSaveThreadGoal"[^>]*>/)![0]
const disabledExpression = saveButton.match(/:disabled="([^"]+)"/)![1]

type Options = { objective?: string; goal?: null; authorized?: boolean; confirm?: boolean; status?: string }
function setup(options: Options = {}) {
  const original = { threadId: 'fixture-budget-thread', objective: 'Preserve original objective', status: 'budgetLimited',
    tokenBudget: 100000, tokensUsed: 117527, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 }
  const resume = vi.fn(async (_budget: number) => true)
  const save = vi.fn(async (_input: unknown) => true)
  const state: Record<string, any> = {
    selectedThreadId: ref(original.threadId), isHomeRoute: ref(false),
    goalEditorObjective: ref(options.objective ?? original.objective), selectedThreadGoal: ref(options.goal === null ? null : original),
    goalEditorStatus: ref(options.status ?? 'budgetLimited'), goalEditorTokenBudget: ref<string | number>('100000'),
    isSavingThreadGoal: ref(false), isLoadingThreadGoal: ref(false), goalEditorError: ref(''),
    goalBudgetOwnerAuthorized: ref(options.authorized ?? true), goalBudgetAuditStatus: ref(''), isGoalEditorOpen: ref(true),
    threadGoalState: { save, resume }, window: { confirm: vi.fn(() => options.confirm ?? true) }, computed, String, Number,
  }
  // Evaluate App's optional computed directly if present (added only after its regression goes red).
  for (const statement of script.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(node => node.name.getText(script) === 'isGoalBudgetAdjustment')) {
      vm.runInNewContext(ts.transpileModule(statement.getText(script), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
        + '\nthis.isGoalBudgetAdjustment = isGoalBudgetAdjustment', state)
    }
  }
  const onSave = vm.runInNewContext(compiledHandler + '\nonSaveThreadGoal', state)
  const events = new Map<string, EventListener>()
  const element = { tagName: 'INPUT', type: budgetInput.match(/type="([^"]+)"/)![1], value: '', composing: false,
    addEventListener(name: string, callback: EventListener) { events.set(name, callback) } } as unknown as HTMLInputElement
  const vnode = { props: { type: element.type, 'onUpdate:modelValue': (value: string | number) => { state.goalEditorTokenBudget.value = value } } }
  ;(vModelText.created as Function)(element, { modifiers: {} }, vnode)
  ;(vModelText.mounted as Function)(element, { value: state.goalEditorTokenBudget.value, modifiers: {} }, vnode)
  return { state, original, resume, save, onSave,
    input(text: string) { element.value = text; events.get('input')!({ target: element } as unknown as Event) },
    disabled() {
      const unwrapped = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value && typeof value === 'object' && 'value' in value ? value.value : value]))
      return Boolean(vm.runInNewContext(disabledExpression, unwrapped))
    },
  }
}

describe('App Goal budget Save with Vue numeric input', () => {
  it.each([{ authorized: false, confirm: true }, { authorized: true, confirm: false }])('does not create a finite Goal without owner approval %j', async approval => {
    const h = setup({ goal: null, objective: 'New finite Goal', ...approval })
    h.input('200000')
    await h.onSave()
    expect(h.save).not.toHaveBeenCalled()
    expect(h.state.isGoalEditorOpen.value).toBe(true)
  })

  it('creates a finite new Goal only after owner confirmation', async () => {
    const h = setup({ goal: null, objective: 'New finite Goal' })
    h.input('200000')
    await h.onSave()
    expect(h.state.window.confirm).toHaveBeenCalledTimes(1)
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ objective: 'New finite Goal', status: 'budgetLimited', tokenBudget: 200000, ownerConfirmed: true })
  })
  it('does not create a new Goal without a finite numeric budget', async () => {
    const h = setup({ goal: null, objective: 'New finite Goal' })
    h.input('')
    await h.onSave()
    expect(h.save).not.toHaveBeenCalled()
    expect(h.state.goalEditorError.value).toMatch(/budget/i)
  })

  it('allows budget-only recovery when the editor objective is blank, preserving the existing objective', async () => {
    const h = setup({ objective: '   ' })
    h.input('200000')
    expect(h.disabled()).toBe(false)
    await h.onSave()
    expect(h.resume).toHaveBeenCalledExactlyOnceWith(200000, true)
    expect(h.save).not.toHaveBeenCalled()
    expect(h.state.selectedThreadGoal.value).toEqual(h.original)
  })

  it('does not silently return from the real budget recovery handler when the editor objective is blank', async () => {
    const h = setup({ objective: '' })
    h.input('200000')
    await h.onSave()
    expect(h.resume).toHaveBeenCalledExactlyOnceWith(200000, true)
    expect(h.save).not.toHaveBeenCalled()
  })

  it.each(['117527', '100000.5', '200000.5', 'Infinity', '9007199254740992'])('rejects an invalid total %s without confirmation or mutation', async budget => {
    const h = setup()
    h.input(budget)
    await h.onSave()
    expect(h.state.goalEditorError.value).toMatch(/finite integer greater than consumed usage/)
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
    expect(h.state.window.confirm).not.toHaveBeenCalled()
  })
  it('requires owner authorization even with a blank editor objective and a valid adjustment', async () => {
    const h = setup({ authorized: false, objective: '' })
    h.input('200000')
    await h.onSave()
    expect(h.state.goalEditorError.value).toMatch(/Owner authorization/)
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
    expect(h.state.window.confirm).not.toHaveBeenCalled()
  })
  it('leaves the editor and accounting intact when owner confirmation is cancelled', async () => {
    const h = setup({ confirm: false })
    h.input('200000')
    await h.onSave()
    expect(h.state.window.confirm).toHaveBeenCalledTimes(1)
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
    expect(h.state.isGoalEditorOpen.value).toBe(true)
    expect(h.state.selectedThreadGoal.value).toEqual(h.original)
  })
  it.each(['', '100000'])('keeps blank-objective saves disabled unless an existing total changes (%s)', async budget => {
    const h = setup({ objective: '' })
    h.input(budget)
    expect(h.disabled()).toBe(true)
    await h.onSave()
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
  })
  it('still requires an objective for a new Goal even when a numeric budget is entered', async () => {
    const h = setup({ objective: '', goal: null })
    h.input('200000')
    expect(h.disabled()).toBe(true)
    await h.onSave()
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
  })
  it.each(['', '100000'])('does not bypass recovery with a blank or unchanged total (%s)', async budget => {
    const h = setup({ status: 'active' })
    h.input(budget)
    await h.onSave()
    expect(h.state.goalEditorError.value).toMatch(/Owner budget adjustment is required/)
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
  })

  it('saves one explicit recovery after Vue type=number coerces the model to a number', async () => {
    expect(budgetInput).toContain('v-model="goalEditorTokenBudget"')
    expect(budgetInput).toContain('type="number"')
    const h = setup()
    h.input('200000')
    expect(h.state.goalEditorTokenBudget.value).toBe(200000)
    await h.onSave()
    expect(h.resume).toHaveBeenCalledExactlyOnceWith(200000, true)
    expect(h.save).not.toHaveBeenCalled()
    expect(h.state.window.confirm).toHaveBeenCalledTimes(1)
    expect(h.state.isGoalEditorOpen.value).toBe(false)
    expect(h.state.selectedThreadGoal.value).toEqual(h.original)
  })
})
