// Shared reviewed-native eligibility contract. No private catalog or instructions belong here.
const ALLOWED = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const AUDITED_BASES = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra'])
// Literal upstreamModelId bindings verified against the installed NineRouter route audit.
const AUDITED_ALIASES = new Map([
  ['cx/gpt-6-astra[1m]', 'gpt-6-astra'],
  ['cx/gpt-6-sol[1m]', 'gpt-6-sol'],
  ['cx/gpt-5.6-sol[1m]', 'gpt-5.6-sol'],
  ['cx/gpt-5.6-sol-review', 'gpt-5.6-sol'],
  ['cx/gpt-5.6-terra[1m]', 'gpt-5.6-terra'],
  ['cx/gpt-5.6-terra-review', 'gpt-5.6-terra'],
])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
function nativeSlugForRoute(id) {
  if (typeof id !== 'string' || !id.startsWith('cx/')) return null
  const slug = id.slice(3)
  return AUDITED_BASES.has(slug) ? slug : AUDITED_ALIASES.get(id) ?? null
}
function indexDescriptors(models) {
  const index = new Map()
  for (const value of Array.isArray(models) ? models : []) {
    const model = record(value)
    if (!model || typeof model.slug !== 'string') continue
    index.set(model.slug, index.has(model.slug) ? null : model)
  }
  return index
}
function nativeUltraWireEffort(value) {
  const model = record(value)
  if (!model || model.reasoning === false || record(model.capabilities)?.reasoning === false
      || model.multi_agent_version !== 'v2' || typeof model.supports_reasoning_effort_updates !== 'boolean') return null
  const levels = model.supported_reasoning_levels
  if (!Array.isArray(levels) || !levels.length) return null
  const efforts = Array.from(levels, level => record(level)?.effort)
  if (efforts.some(effort => !ALLOWED.has(effort)) || !efforts.includes('ultra')
    || !efforts.includes(model.default_reasoning_level) || model.default_reasoning_level === 'ultra') return null
  const declared = model.multi_agent_reasoning_effort
  if (declared !== undefined && declared !== null && !ALLOWED.has(declared)) return null
  // Exact 0.154 resolver: valid supported non-Ultra declaration, Max, last non-Ultra, Medium.
  if (declared !== 'ultra' && efforts.includes(declared)) return declared
  return efforts.includes('max') ? 'max' : [...efforts].reverse().find(effort => effort !== 'ultra') ?? 'medium'
}
function providerWireEfforts(value) {
  const row = record(value)
  if (!row || row.reasoning === false || record(row.capabilities)?.reasoning === false) return false
  let supported = null
  for (const key of ['supportedReasoningEfforts', 'supported_reasoning_efforts', 'thinkingLevels']) {
    if (!Object.hasOwn(row, key)) continue
    const values = row[key]
    if (!Array.isArray(values) || !values.length) return false
    const efforts = Array.from(values, effort => typeof effort === 'string' ? effort
      : record(effort)?.reasoningEffort ?? record(effort)?.reasoning_effort)
    if (efforts.some(effort => !ALLOWED.has(effort))) return false
    const current = new Set(efforts.filter(effort => effort !== 'ultra'))
    supported = supported === null ? current : new Set([...supported].filter(effort => current.has(effort)))
    if (!supported.size) return false
  }
  return supported
}
export { nativeSlugForRoute, indexDescriptors, nativeUltraWireEffort, providerWireEfforts }
