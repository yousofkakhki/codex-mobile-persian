import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'
import ts from 'typescript'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

it('PUB-ACT-03 real Activity template offers a disabled-aware explicit recent continuation action', async () => {
  const filename = resolve('src/components/content/ThreadActivity.vue')
  const template = parse(readFileSync(filename, 'utf8')).descriptor.template!.content
  const compiled = compileTemplate({ source: template, filename, id: 'cycle1-continuation' })
  expect(compiled.errors).toEqual([])
  const source = ts.transpileModule(compiled.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText + `
    import { createApp, ref } from 'vue';
    const loading = ref(false);
    window.__cycle = { calls: 0, loading };
    createApp({ render, setup: () => ({
      entries: [], visibleEntries: [], coverage: null, loading, error: '', hasOlder: false,
      following: true, offsets: [0], start: 0, end: 0,
      onScroll: () => {}, refresh: () => { window.__cycle.calls++; loading.value = true; },
    }) }).mount('#app');`
  const script = await build({ configFile: false, logLevel: 'silent',
    plugins: [{ name: 'private-cycle1-template', resolveId: id => id === 'cycle1-template' ? '\u0000cycle1-template' : null,
      load: id => id === '\u0000cycle1-template' ? source : null }],
    build: { write: false, rollupOptions: { input: 'cycle1-template', output: { format: 'iife', inlineDynamicImports: true } } } })
  const chunks = (Array.isArray(script) ? script : [script]).flatMap(value => 'output' in value ? value.output : [])
  const bundle = chunks.find(value => value.type === 'chunk')
  if (!bundle || bundle.type !== 'chunk') throw new Error('Private template bundle missing')
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'], headless: true })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const escaped: string[] = []
  const errors: string[] = []
  try {
    await context.route('**/*', route => { escaped.push(route.request().url()); return route.abort() })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<div id="app"></div>')
    await page.addScriptTag({ content: bundle.code })
    const button = page.getByRole('button', { name: 'Load recent updates', exact: true })
    expect(await button.count()).toBe(1)
    await button.click()
    expect(await page.evaluate(() => (window as any).__cycle.calls)).toBe(1)
    expect(await button.isDisabled()).toBe(true)
    expect(escaped).toEqual([])
    expect(errors).toEqual([])
  } finally { await context.close(); await browser.close() }
})
