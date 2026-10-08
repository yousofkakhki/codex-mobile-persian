const fs = require('node:fs')
const path = require('node:path')

function extractBundledCatalog(binary) {
  const marker = binary.indexOf(Buffer.from('"supported_reasoning_levels"'))
  const start = binary.lastIndexOf(Buffer.from('{\n  "models"'), marker)
  if (marker < 0 || start < 0) throw new Error('Bundled Codex model catalog not found; no output written')
  const text = binary.subarray(start, start + 4 * 1024 * 1024).toString('utf8')
  let depth = 0, quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      if (--depth === 0) return JSON.parse(text.slice(0, i + 1))
    }
  }
  throw new Error('Bundled catalog exceeded extraction bound; no output written')
}

function buildCatalog(bundled, advertised) {
  if (!Array.isArray(bundled.models) || !bundled.models.length) throw new Error('Empty bundled catalog')
  const models = structuredClone(bundled.models)
  const bySlug = new Map(models.map(model => [model.slug, model]))
  const aliases = new Set()
  for (const row of advertised.data ?? []) {
    if (typeof row.id !== 'string' || !row.id.startsWith('cx/') || aliases.has(row.id)) continue
    if (row.capabilities?.reasoning === false) continue
    const context = row.context_length ?? row.capabilities?.contextWindow
    if (!Number.isSafeInteger(context) || context <= 0) continue
    const slug = row.id.slice(3).replace(/\[1m\]$/, '').replace(/-review$/, '')
    // Preserve real Codex instructions/tool behavior, not an invented descriptor.
    // Newly advertised Sol/Luna variants inherit the same family's bundled descriptor.
    const family = /^gpt-6(?:\.1)?-(sol|luna)$/.exec(slug)
    const template = bySlug.get(slug) ?? (family ? bySlug.get(`gpt-5.6-${family[1]}`) : null)
    if (!template) continue
    const nativeContext = template.context_window
    if (!Number.isSafeInteger(nativeContext) || nativeContext <= 0) continue
    const nativeCompactionLimit = Number.isSafeInteger(template.auto_compact_token_limit)
      && template.auto_compact_token_limit > 0
      ? template.auto_compact_token_limit
      : Math.floor(nativeContext * 0.9)
    const model = structuredClone(template)
    model.slug = row.id
    model.display_name = row.id
    model.context_window = context
    model.max_context_window = context
    model.auto_compact_token_limit = Math.min(nativeCompactionLimit, Math.floor(context * 0.9))
    model.prefer_websockets = false // The local gateway accepts streamed HTTP Responses.
    model.visibility = 'list'
    const explicit = row.thinkingLevels ?? row.supportedReasoningEfforts
    const efforts = Array.isArray(explicit) ? explicit.map(value => typeof value === 'string' ? value : value.reasoningEffort) :
      /^gpt-6-astra$/.test(slug) ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max']
    model.supported_reasoning_levels = efforts.filter(effort => ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)).map(effort => ({ effort, description: `Gateway-supported ${effort} reasoning` }))
    if (!model.supported_reasoning_levels.some(level => level.effort === model.default_reasoning_level)) model.default_reasoning_level = 'medium'
    aliases.add(row.id)
    models.push(model)
  }
  if (!aliases.size) throw new Error('No compatible advertised cx model descriptors; no output written')
  return { models }
}

async function main() {
  const args = process.argv.slice(2)
  const option = name => args[args.indexOf(name) + 1]
  if (!args.includes('--binary') || !args.includes('--output')) throw new Error('Required: --binary <Codex binary> --output <catalog.json>; optional --models-url <URL>')
  const response = await fetch(args.includes('--models-url') ? option('--models-url') : 'http://127.0.0.1:20128/v1/models', { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`Gateway catalog HTTP ${response.status}`)
  const catalog = buildCatalog(extractBundledCatalog(fs.readFileSync(option('--binary'))), await response.json())
  const output = path.resolve(option('--output'))
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 })
  fs.renameSync(temporary, output)
  console.log(`Catalog written: ${catalog.models.length} descriptors; no credentials included`)
}
module.exports = { extractBundledCatalog, buildCatalog }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
