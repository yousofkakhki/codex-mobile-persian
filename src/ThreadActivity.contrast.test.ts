import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import vm from 'node:vm'
import ts from 'typescript'
import { parse, compileTemplate } from 'vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Render the real Activity template and compile the real stylesheet, rather than
// asserting on a hand-made color sample. Only read-side component props are fixtures.
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const template = parse(readFileSync(join(repo, 'src/components/content/ThreadActivity.vue'), 'utf8')).descriptor.template!.content
const selectors = ['.activity-entry-time', '.activity-provenance', '.activity-duration', '.activity-turn-label', '.activity-entry-state', '.activity-coverage']
const luminance = (values: number[]) => values.map(value => value / 255)
  .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
function contrast(foreground: string, background: string): number {
  const channel = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number)
  const [low, high] = [luminance(channel(foreground)), luminance(channel(background))].sort((a, b) => a - b)
  return (high + .05) / (low + .05)
}

let browser: Browser
let css: string
let html: string
beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'activity-contrast-'))
  symlinkSync(join(repo, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const appStyles = parse(readFileSync(join(repo, 'src/App.vue'), 'utf8')).descriptor.styles.map(style => style.content).join('\n')
  const hostStyle = appStyles.match(/\.content-root\s*\{[^}]*\}/)![0]
  writeFileSync(join(scratch, 'style.css'), `${readFileSync(join(repo, 'src/style.css'), 'utf8')}\n${hostStyle}`)
  await build({ configFile: false, root: scratch, cacheDir: join(scratch, 'cache'),
    plugins: [tailwindcss()], logLevel: 'silent',
    build: { outDir: join(scratch, 'bundle'), rollupOptions: { input: join(scratch, 'style.css') } },
  })
  const assets = join(scratch, 'bundle/assets')
  css = readFileSync(join(assets, readdirSync(assets).find(name => name.endsWith('.css'))!), 'utf8')
  const entries = ['completed', 'running', 'failed'].map((status, index) => ({
    id: `contrast-${status}`, threadId: 'synthetic-contrast', turnId: `turn-${index}`, status,
    title: `Synthetic ${status} activity`, summary: 'Read-only contrast fixture', startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:01Z', durationMs: 1000, hasDetail: true, reconstructed: true,
  }))
  const compiled = compileTemplate({ source: template, filename: 'ThreadActivity.vue', id: 'activity-contrast' })
  expect(compiled.errors).toEqual([])
  const js = ts.transpileModule(compiled.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports: Record<string, any> = {}
  vm.runInNewContext(js, { exports, require: (id: string) => { if (id !== 'vue') throw new Error(`Unexpected template import: ${id}`); return Vue } })
  html = await renderToString(Vue.createSSRApp({ render: exports.render, setup: () => ({
    coverage: { recordingSince: '2026-01-01T00:00:00Z', recoveredHistory: true, recoveryComplete: true },
    entries, visibleEntries: entries, error: '', hasOlder: false, loading: false, following: true,
    offsets: [0, 100, 200, 300], start: 0, end: 3, expanded: '', detailText: '', detailLoading: false,
    detailError: '', detailCursor: null, now: Date.parse('2026-01-01T00:00:01Z'),
    formatActivityDuration: () => '1s', observeRow: () => {}, onScroll: () => {}, toggle: () => {},
    loadEarlier: async () => {}, loadRecovered: async () => {}, refresh: async () => {},
    jumpToLatest: async () => {}, readDetail: async () => {},
  }) }))
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'], headless: true })
}, 30000)
afterAll(async () => { await browser?.close() })

for (const dark of [false, true]) describe(`${dark ? 'dark' : 'light'} real Activity template contrast`, () => {
  it('keeps all small metadata readable while retaining distinct running and failed states', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const errors: string[] = []
    const escaped: string[] = []
    try {
      await context.route('**/*', route => { escaped.push(route.request().url()); return route.abort() })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.setContent(`<html class="${dark ? 'dark' : ''}"><head></head><body><main class="content-root">${html}</main></body></html>`)
      await page.addStyleTag({ content: css })
      const measurements = await page.evaluate(selectors => {
        const rgb = (color: string) => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
          const drawing = canvas.getContext('2d')!
          drawing.fillStyle = color; drawing.fillRect(0, 0, 1, 1)
          const channels = drawing.getImageData(0, 0, 1, 1).data
          return `rgb(${Array.from(channels).slice(0, 3).join(', ')})`
        }
        const background = rgb(getComputedStyle(document.querySelector('.content-root')!).backgroundColor)
        const sample = (selector: string) => {
          const element = document.querySelector(selector)!
          const style = getComputedStyle(element)
          return { selector, color: style.color, background, size: style.fontSize }
        }
        return { metadata: selectors.map(sample), running: sample('[data-status="running"] .activity-entry-state'),
          failed: sample('[data-status="failed"] .activity-entry-state') }
      }, selectors)
      for (const sample of measurements.metadata) expect(contrast(sample.color, sample.background), JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5)
      expect(measurements.running.color).not.toBe(measurements.failed.color)
      expect(contrast(measurements.running.color, measurements.running.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(measurements.failed.color, measurements.failed.background)).toBeGreaterThanOrEqual(4.5)
      expect(errors).toEqual([])
      expect(escaped).toEqual([])
    } finally { await context.close() }
  })
})
