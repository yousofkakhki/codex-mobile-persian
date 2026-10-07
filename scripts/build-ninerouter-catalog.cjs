const fs = require('node:fs')
const path = require('node:path')
const { nativeSlugForRoute, indexDescriptors, nativeUltraWireEffort, providerWireEfforts } = require('../src/server/runtimeLocalUltra.mjs')

function extractBundledCatalog(binary) {
  const marker = binary.indexOf(Buffer.from('"supported_reasoning_levels"'))
  const start = marker < 0 ? -1 : binary.lastIndexOf(Buffer.from('{\n  "models"'), marker)
  if (start < 0) throw new Error('Bundled Codex model catalog not found; no output written')
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

function validateNativeCatalog(nativeCatalog) {
  if (!nativeCatalog || typeof nativeCatalog !== 'object' || Array.isArray(nativeCatalog)
    || !Array.isArray(nativeCatalog.models) || !nativeCatalog.models.length) {
    throw new Error('Invalid native catalog; no output written')
  }
  const descriptors = indexDescriptors(nativeCatalog.models)
  if (![...descriptors.values()].some(model => nativeUltraWireEffort(model))) {
    throw new Error('Invalid native catalog: no unambiguous eligible descriptors; no output written')
  }
  return descriptors
}

function buildCatalog(bundled, advertised, nativeCatalog) {
  if (!Array.isArray(bundled?.models) || !bundled.models.length) throw new Error('Empty bundled catalog')
  const nativeDescriptors = nativeCatalog === undefined ? null : validateNativeCatalog(nativeCatalog)
  if (nativeDescriptors && !Array.isArray(advertised?.data)) throw new Error('Invalid advertised catalog; no output written')
  const models = structuredClone(bundled.models)
  const bySlug = new Map(models.map(model => [model.slug, model]))
  const aliases = new Set(models.map(model => model.slug))
  const counts = new Map()
  if (nativeDescriptors) for (const row of advertised.data) {
    if (row && nativeSlugForRoute(row.id)) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  }
  let added = 0
  for (const row of advertised?.data ?? []) {
    if (!row || typeof row.id !== 'string' || !row.id.startsWith('cx/') || aliases.has(row.id)) continue
    if ((counts.get(row.id) ?? 0) > 1 || row.capabilities?.reasoning === false || row.reasoning === false) continue
    const context = row.context_length ?? row.capabilities?.contextWindow
    if (!Number.isSafeInteger(context) || context <= 0) continue
    const slug = row.id.slice(3).replace(/-review$/, '').replace(/\[1m\]$/, '')
    // Reuse actual bundled Codex instructions/tool behavior, never invent it.
    const family = /^gpt-6(?:\.1)?-(sol|luna)$/.exec(slug)
    const auditedSlug = nativeDescriptors && nativeSlugForRoute(row.id)
    const nativeExact = auditedSlug ? nativeDescriptors.get(auditedSlug) : null
    const nativeWire = nativeUltraWireEffort(nativeExact)
    if (auditedSlug && !nativeWire) continue
    const nativeEfforts = nativeExact ? providerWireEfforts(row) : null
    if (nativeEfforts === false || nativeEfforts && !nativeEfforts.has(nativeWire)) continue
    const template = nativeExact ?? bySlug.get(slug) ?? (family ? bySlug.get(`gpt-5.6-${family[1]}`) : null)
    if (!template) continue
    const model = structuredClone(template)
    model.slug = row.id
    model.display_name = row.id
    model.context_window = context
    model.max_context_window = context
    model.auto_compact_token_limit = null
    model.prefer_websockets = false
    model.visibility = 'list'
    const explicit = row.supportedReasoningEfforts ?? row.supported_reasoning_efforts ?? row.thinkingLevels
    const efforts = Array.isArray(explicit)
      ? explicit.map(value => typeof value === 'string' ? value : value?.reasoningEffort ?? value?.reasoning_effort)
      : slug === 'gpt-6-astra' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max']
    const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    const supported = [...new Set(efforts.filter(effort => allowed.has(effort) && (!nativeDescriptors || nativeExact || effort !== 'ultra')))]
    if (!supported.length) continue
    if (nativeExact) {
      if (nativeEfforts) model.supported_reasoning_levels = model.supported_reasoning_levels.filter(level => level.effort === 'ultra' || nativeEfforts.has(level.effort))
      const nativeSupported = model.supported_reasoning_levels.map(level => level.effort)
      if (!nativeSupported.includes(model.default_reasoning_level)) model.default_reasoning_level = nativeSupported.includes('medium') ? 'medium' : nativeSupported.find(effort => effort !== 'ultra')
    } else {
      model.supported_reasoning_levels = supported.map(effort => ({ effort, description: `Gateway-supported ${effort} reasoning` }))
      if (!supported.includes(model.default_reasoning_level)) model.default_reasoning_level = supported.includes('medium') ? 'medium' : supported[0]
    }
    aliases.add(row.id)
    models.push(model)
    added++
  }
  if (!added) throw new Error('No compatible advertised cx model descriptors; no output written')
  return { models }
}

async function main() {
  const args = process.argv.slice(2)
  const option = name => {
    const index = args.indexOf(name)
    const value = index < 0 ? '' : args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing ${name}; Required: --binary <Codex binary> --output <catalog.json>`)
    return value
  }
  const binaryPath = option('--binary')
  const output = path.resolve(option('--output'))
  const url = args.includes('--models-url') ? option('--models-url') : 'http://127.0.0.1:20128/v1/models'
  const nativeCatalog = args.includes('--native-catalog') ? JSON.parse(fs.readFileSync(option('--native-catalog'), 'utf8')) : undefined
  if (nativeCatalog !== undefined) validateNativeCatalog(nativeCatalog)
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`Gateway catalog HTTP ${response.status}`)
  const catalog = buildCatalog(extractBundledCatalog(fs.readFileSync(binaryPath)), await response.json(), nativeCatalog)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, output)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
  console.log(`Catalog written: ${catalog.models.length} descriptors; no credentials included`)
}

module.exports = { buildCatalog, extractBundledCatalog }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
