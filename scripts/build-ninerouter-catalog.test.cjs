const { test } = require('node:test')
const assert = require('node:assert/strict')
let api
try { api = require('./build-ninerouter-catalog.cjs') } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

test('preserves bundled descriptors and exact cx aliases with advertised per-model context', () => {
  assert.equal(typeof api?.buildCatalog, 'function', 'catalog builder must exist')
  const bundled = { models: [{ slug: 'gpt-5.6-sol', context_window: 272000, model_messages: { instructions: 'fixture real descriptor' }, default_reasoning_level: 'low', prefer_websockets: true }] }
  const original = structuredClone(bundled)
  const output = api.buildCatalog(bundled, { data: [
    { id: 'cx/gpt-6.1-sol', context_length: 1050000 },
    { id: 'cx/gpt-5.6-sol[1m]', capabilities: { contextWindow: 872000 } },
    { id: 'cx/gpt-5.6-sol[1m]', context_length: 1 },
  ] })
  assert.equal(output.models[0].context_window, 272000)
  assert.equal(output.models[1].context_window, 1050000)
  assert.equal(output.models[1].max_context_window, 1050000)
  assert.equal(output.models[2].slug, 'cx/gpt-5.6-sol[1m]')
  assert.equal(output.models[2].context_window, 872000)
  assert.deepEqual(output.models[1].model_messages, bundled.models[0].model_messages)
  assert.deepEqual(bundled, original)
  assert.equal(output.models[1].prefer_websockets, false)
  assert.equal(output.models[1].auto_compact_token_limit, null)
  assert.equal(output.models.length, 3)
})

test('uses provider reasoning declarations before family defaults and chooses a supported default', () => {
  const bundled = { models: [
    { slug: 'gpt-5.6-sol', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] },
    { slug: 'gpt-6-astra', default_reasoning_level: 'medium' },
  ] }
  const output = api.buildCatalog(bundled, { data: [
    { id: 'cx/gpt-6.1-sol[1m]-review', context_length: 1000, supportedReasoningEfforts: [{ reasoningEffort: 'high' }, 'high', 'invalid'] },
    { id: 'cx/gpt-6-astra[1m]-review', context_length: 1000 },
    { id: 'cx/gpt-5.6-sol', context_length: 1000, thinkingLevels: [] },
    { id: 'cx/gpt-5.6-sol-review', context_length: 1000, capabilities: { reasoning: false } },
  ] })
  assert.deepEqual(output.models[2].supported_reasoning_levels.map(level => level.effort), ['high'])
  assert.equal(output.models[2].default_reasoning_level, 'high')
  assert.deepEqual(output.models[3].supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(output.models.length, 4)
  assert.throws(() => api.buildCatalog({ models: [{ slug: 'other' }] }, { data: [{ id: 'cx/unknown', context_length: 1000 }] }), /No compatible/)
})

test('extracts bounded bundled JSON while respecting escapes and fails closed on unknown binary formats', () => {
  assert.equal(typeof api.extractBundledCatalog, 'function', 'binary extractor must exist')
  assert.throws(() => api.extractBundledCatalog(Buffer.from('no catalog')), /not found/)
  const data = { models: [{ slug: 'm', supported_reasoning_levels: [], description: 'brace } [ and escaped "quote" \\ in string' }] }
  assert.deepEqual(api.extractBundledCatalog(Buffer.from('prefix' + JSON.stringify(data, null, 2) + 'suffix')), data)
  assert.throws(() => api.extractBundledCatalog(Buffer.from('{\n  "models": [{"supported_reasoning_levels": [], "long":"' + 'x'.repeat(4 * 1024 * 1024) + '"}]}')), /bound/)
})

test('CLI uses one offline catalog fetch and atomically writes a private file only on success', async () => {
  const fs = require('node:fs/promises')
  const { join } = require('node:path')
  const { tmpdir } = require('node:os')
  const { spawnSync } = require('node:child_process')
  const dir = await fs.mkdtemp(join(tmpdir(), 'metadata-builder-cli-'))
  const binary = join(dir, 'fixture-binary')
  const output = join(dir, 'output.json')
  const preload = join(dir, 'offline-fetch.cjs')
  const data = { models: [{ slug: 'gpt-5.6-sol', supported_reasoning_levels: [], default_reasoning_level: 'low' }] }
  const cli = (...args) => spawnSync(process.execPath, ['--require', preload, require.resolve('./build-ninerouter-catalog.cjs'), ...args], { encoding: 'utf8' })
  try {
    await fs.writeFile(binary, 'prefix' + JSON.stringify(data, null, 2) + 'suffix')
    await fs.writeFile(preload, `globalThis.fetch = async (url) => { if (url !== 'https://offline.invalid/models') throw new Error('unexpected network target'); console.log('FIXTURE_REQUEST_COUNT=1'); return new Response(JSON.stringify({data:[{id:'cx/gpt-6.1-sol',context_length:1000}]}), {status:200}) }`)
    let result = cli('--binary', binary, '--output', output, '--models-url', 'https://offline.invalid/models')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Catalog written: 2 descriptors/)
    assert.equal(result.stdout.split('FIXTURE_REQUEST_COUNT=1').length - 1, 1)
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600)
    const previous = await fs.readFile(output, 'utf8')
    assert.equal(JSON.parse(previous).models[1].slug, 'cx/gpt-6.1-sol')
    await fs.writeFile(preload, `globalThis.fetch = async () => new Response('{}', {status:503})`)
    result = cli('--binary', binary, '--output', output, '--models-url', 'https://offline.invalid/models')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /HTTP 503/)
    assert.equal(await fs.readFile(output, 'utf8'), previous)
    result = cli('--binary', binary, '--output')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Required|Missing/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('matches metadata precedence when explicit supported efforts coexist with thinkingLevels', () => {
  const bundled = { models: [{ slug: 'gpt-5.6-sol', default_reasoning_level: 'medium' }] }
  const output = api.buildCatalog(bundled, { data: [{
    id: 'cx/gpt-6.1-sol', context_length: 1000,
    supportedReasoningEfforts: ['high'], supported_reasoning_efforts: ['medium'], thinkingLevels: ['low'],
  }] })
  assert.deepEqual(output.models[1].supported_reasoning_levels.map(level => level.effort), ['high'])
  assert.equal(output.models[1].default_reasoning_level, 'high')
})

const nativeFixture = () => ({ models: [{
  slug: 'gpt-6.1-sol', display_name: 'Native exact',
  description: 'native descriptor fixture', context_window: 1000000,
  default_reasoning_level: 'high', supports_reasoning_effort_updates: true,
  multi_agent_version: 'v2', multi_agent_reasoning_effort: 'xhigh',
  supported_reasoning_levels: [
    { effort: 'low', description: 'native low' },
    { effort: 'high', description: 'native high' },
    { effort: 'xhigh', description: 'native xhigh' },
    { effort: 'ultra', description: 'native local multi-agent' },
  ],
  base_instructions: 'native exact instructions',
  model_messages: { instructions: 'native exact nested instructions', nested: { keep: ['literal'] } },
  experimental_supported_tools: ['native-tool'],
  apply_patch_tool_type: 'freeform', shell_type: 'shell_command',
  tool_behavior: { nested: { preserve: true } }, future_native_field: { keep: 'entire descriptor' },
}] })
const bundledFixture = () => ({ models: [
  { slug: 'gpt-5.6-sol', default_reasoning_level: 'medium', model_messages: { instructions: 'family sol' } },
  { slug: 'gpt-5.6-luna', default_reasoning_level: 'medium', model_messages: { instructions: 'family luna' } },
] })
const exactAdvertisement = (fields = {}) => ({ data: [{ id: 'cx/gpt-6.1-sol', context_length: 1050000, ...fields }] })

test('native exact alias clones the entire true descriptor without mutating any input', () => {
  const bundled = bundledFixture(), native = nativeFixture(), advertised = exactAdvertisement()
  const before = structuredClone({ bundled, native, advertised })
  const output = api.buildCatalog(bundled, advertised, native)
  const exact = output.models.find(model => model.slug === 'cx/gpt-6.1-sol')
  assert.deepEqual(exact, { ...native.models[0],
    slug: 'cx/gpt-6.1-sol', display_name: 'cx/gpt-6.1-sol',
    context_window: 1050000, max_context_window: 1050000,
    auto_compact_token_limit: null, prefer_websockets: false, visibility: 'list',
  })
  assert.deepEqual(output.models.slice(0, bundled.models.length), bundled.models)
  assert.deepEqual({ bundled, native, advertised }, before)
  exact.model_messages.nested.keep.push('output-only')
  assert.deepEqual(native.models[0].model_messages.nested.keep, ['literal'])
})


test('explicit native top-level reasoning false rejects even the reviewed exact descriptor', () => {
  const native = process.env.CODEXUI_TEST_NATIVE_CATALOG
    ? JSON.parse(require('node:fs').readFileSync(process.env.CODEXUI_TEST_NATIVE_CATALOG, 'utf8'))
    : nativeFixture()
  const before = structuredClone(native)
  assert.ok(api.buildCatalog(bundledFixture(), exactAdvertisement(), native).models.some(model => model.slug === 'cx/gpt-6.1-sol'))
  const restrictive = structuredClone(native)
  restrictive.models.find(model => model.slug === 'gpt-6.1-sol').reasoning = false
  assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement(), restrictive), /Invalid native catalog|No compatible/)
  assert.deepEqual(native, before, 'read-only native input is unchanged')
})

test('invalid native catalogs fail closed instead of falling back to an Ultra family descriptor', () => {
  const invalid = [null, false, [], {}, { models: false }, { models: [] }, { models: {} },
    { models: [null] },
    { models: [nativeFixture().models[0], nativeFixture().models[0]] },
  ]
  for (const change of [
    { supports_reasoning_effort_updates: 'true' },
    { supports_reasoning_effort_updates: undefined }, { capabilities: { reasoning: false } },
    { multi_agent_version: 'v1' }, { multi_agent_version: undefined },
    { supported_reasoning_levels: [] }, { supported_reasoning_levels: null },
    { supported_reasoning_levels: false }, { supported_reasoning_levels: 'xhigh,ultra' },
    { supported_reasoning_levels: [{ effort: 'ultra' }, { effort: 'max' }] },
    { supported_reasoning_levels: [{ effort: 'xhigh' }, { effort: 'max' }] },
    { supported_reasoning_levels: [{ effort: 'xhigh' }, { effort: 'ultra' }, {}] },
    { supported_reasoning_levels: [{ effort: 'xhigh' }, { effort: 'ultra' }, { effort: false }] },
    { supported_reasoning_levels: ['xhigh', 'ultra'] },
    { default_reasoning_level: 'unsupported' },
  ]) invalid.push({ models: [{ ...nativeFixture().models[0], ...change }] })
  for (const native of invalid) {
    assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement(), native), /Invalid native catalog/)
  }
})


test('native exact override treats every explicit provider effort list as a restrictive wire contract', () => {
  const keepOther = { id: 'cx/gpt-5.6-luna', context_length: 2000 }
  const absent = api.buildCatalog(bundledFixture(), exactAdvertisement(), nativeFixture())
  assert.deepEqual(absent.models[2].supported_reasoning_levels, nativeFixture().models[0].supported_reasoning_levels)
  for (const fields of [
    { capabilities: { reasoning: false } },
    ...['supportedReasoningEfforts', 'supported_reasoning_efforts', 'thinkingLevels'].flatMap(key =>
      [[], false, null, 'xhigh', {}, ['high'], ['max', 'ultra'], ['xhigh', {}], ['xhigh', null], ['xhigh', 'invalid']]
        .map(value => ({ [key]: value }))),
    { supportedReasoningEfforts: null, thinkingLevels: ['xhigh'] },
    { supportedReasoningEfforts: ['xhigh'], supported_reasoning_efforts: [] },
    { supportedReasoningEfforts: ['xhigh'], thinkingLevels: ['max'] },
  ]) {
    assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement(fields), nativeFixture()), /No compatible/)
    const mixed = { data: [...exactAdvertisement(fields).data, keepOther] }
    const output = api.buildCatalog(bundledFixture(), mixed, nativeFixture())
    assert.equal(output.models.some(model => model.slug === 'cx/gpt-6.1-sol'), false)
    assert.equal(output.models.at(-1).slug, keepOther.id)
  }
})


test('provider xhigh restricts native wire choices while preserving native Ultra policy and descriptions', () => {
  for (const field of ['supportedReasoningEfforts', 'supported_reasoning_efforts', 'thinkingLevels']) {
    for (const effort of ['xhigh', { reasoningEffort: 'xhigh' }, { reasoning_effort: 'xhigh' }]) {
      const native = nativeFixture()
      const output = api.buildCatalog(bundledFixture(), exactAdvertisement({ [field]: [effort] }), native)
      const exact = output.models.at(-1)
      assert.deepEqual(exact.supported_reasoning_levels, native.models[0].supported_reasoning_levels.filter(level => ['xhigh', 'ultra'].includes(level.effort)))
      assert.equal(exact.default_reasoning_level, 'xhigh')
      assert.equal(exact.multi_agent_reasoning_effort, 'xhigh')
      assert.deepEqual(exact.tool_behavior, native.models[0].tool_behavior)
    }
  }
})


test('native override rejects empty or malformed provider catalogs before alias generation', () => {
  for (const advertised of [false, null, [], {}, { data: false }, { data: {} }, { data: 'cx/gpt-6.1-sol' }, { data: [] }, { data: [null] }, { data: [{ id: false }] }]) {
    assert.throws(() => api.buildCatalog(bundledFixture(), advertised, nativeFixture()), /Invalid advertised catalog|No compatible/)
  }
})


test('CLI validates native input before fetching or overwriting output', async () => {
  const fs = require('node:fs/promises')
  const { join } = require('node:path')
  const { tmpdir } = require('node:os')
  const { spawnSync } = require('node:child_process')
  const dir = await fs.mkdtemp(join(tmpdir(), 'metadata-builder-native-preflight-'))
  const binary = join(dir, 'fixture-binary'), output = join(dir, 'output.json')
  const preload = join(dir, 'offline-fetch.cjs'), native = join(dir, 'native.json')
  const cli = (...args) => spawnSync(process.execPath, ['--require', preload, require.resolve('./build-ninerouter-catalog.cjs'), '--binary', binary, '--output', output, '--models-url', 'https://offline.invalid/models', ...args], { encoding: 'utf8' })
  try {
    await fs.writeFile(output, 'sentinel')
    await fs.writeFile(preload, `globalThis.fetch = async () => { console.log('UNEXPECTED_FETCH'); throw new Error('must validate native input before network') }`)
    for (const value of ['not-json', 'null', 'false', '{}', '{"models":[]}', JSON.stringify({ models: [{ ...nativeFixture().models[0], supports_reasoning_effort_updates: 'false' }] })]) {
      await fs.writeFile(native, value)
      const result = cli('--native-catalog', native)
      assert.equal(result.status, 1)
      assert.doesNotMatch(result.stdout, /UNEXPECTED_FETCH/)
      assert.match(result.stderr, /native|JSON/i)
      assert.equal(await fs.readFile(output, 'utf8'), 'sentinel')
    }
    const missing = cli('--native-catalog')
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /Missing --native-catalog/)
    assert.doesNotMatch(missing.stdout, /UNEXPECTED_FETCH/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})


test('CLI native option writes the exact native descriptor using a single offline GET', async () => {
  const fs = require('node:fs/promises')
  const { join } = require('node:path')
  const { tmpdir } = require('node:os')
  const { spawnSync } = require('node:child_process')
  const dir = await fs.mkdtemp(join(tmpdir(), 'metadata-builder-native-cli-'))
  const binary = join(dir, 'fixture-binary'), output = join(dir, 'output.json')
  const preload = join(dir, 'offline-fetch.cjs'), nativePath = join(dir, 'native.json')
  const native = nativeFixture(), bundled = bundledFixture(), advertised = exactAdvertisement()
  try {
    await fs.writeFile(binary, 'prefix' + JSON.stringify(bundled, null, 2).replace('"default_reasoning_level"', '"supported_reasoning_levels": [], "default_reasoning_level"') + 'suffix')
    await fs.writeFile(nativePath, JSON.stringify(native))
    await fs.writeFile(preload, `globalThis.fetch = async (url, options) => { if (url !== 'https://offline.invalid/models' || (options.method ?? 'GET') !== 'GET' || options.headers) throw new Error('unexpected network operation'); console.log('FIXTURE_REQUEST_COUNT=1'); return new Response(${JSON.stringify(JSON.stringify(advertised))}, {status:200}) }`)
    const result = spawnSync(process.execPath, ['--require', preload, require.resolve('./build-ninerouter-catalog.cjs'), '--binary', binary, '--output', output, '--models-url', 'https://offline.invalid/models', '--native-catalog', nativePath], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.split('FIXTURE_REQUEST_COUNT=1').length - 1, 1)
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600)
    const actual = JSON.parse(await fs.readFile(output, 'utf8')).models.at(-1)
    assert.deepEqual(actual, { ...native.models[0], slug: 'cx/gpt-6.1-sol', display_name: 'cx/gpt-6.1-sol', context_window: 1050000, max_context_window: 1050000, auto_compact_token_limit: null, prefer_websockets: false, visibility: 'list' })
    assert.deepEqual((await fs.readdir(dir)).sort(), ['fixture-binary', 'native.json', 'offline-fetch.cjs', 'output.json'])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})


test('native exact binding never borrows family, review, extended-context, or luna routes', () => {
  const bundled = bundledFixture(), native = nativeFixture()
  const variants = ['cx/gpt-6-sol', 'cx/gpt-6.1-sol-review', 'cx/gpt-6.1-sol[1m]', 'cx/gpt-6.1-sol[1m]-review', 'cx/gpt-6.1-luna', 'cx/gpt-5.6-sol', 'cx/gpt-5.6-luna']
  const advertised = { data: [...exactAdvertisement().data, ...variants.map(id => ({ id, context_length: 1000 }))] }
  const before = api.buildCatalog(bundled, advertised)
  const after = api.buildCatalog(bundled, advertised, native)
  const missingNative = ['cx/gpt-6-sol', 'cx/gpt-5.6-sol']
  const excluded = ['cx/gpt-6.1-sol', ...missingNative]
  assert.deepEqual(after.models.filter(model => !excluded.includes(model.slug)), before.models.filter(model => !excluded.includes(model.slug)))
  assert.equal(after.models.some(model => missingNative.includes(model.slug)), false)
  assert.equal(after.models.filter(model => model.multi_agent_version === 'v2').length, 1)
  for (const model of after.models.filter(model => variants.includes(model.slug))) {
    assert.equal(model.supported_reasoning_levels.some(level => level.effort === 'ultra'), false)
  }
})

test('Max stays a separate native effort and can never substitute for Ultra or wire xhigh', () => {
  const native = nativeFixture()
  native.models[0].supported_reasoning_levels.splice(3, 0, { effort: 'max', description: 'native distinct max' })
  const exact = api.buildCatalog(bundledFixture(), exactAdvertisement({ supportedReasoningEfforts: ['high', 'xhigh', 'max'] }), native).models.at(-1)
  assert.deepEqual(exact.supported_reasoning_levels.map(level => level.effort), ['high', 'xhigh', 'max', 'ultra'])
  assert.equal(exact.supported_reasoning_levels.find(level => level.effort === 'max').description, 'native distinct max')
  assert.equal(exact.multi_agent_reasoning_effort, 'xhigh')
  assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement({ supportedReasoningEfforts: ['max'] }), native), /No compatible/)
  native.models[0].supported_reasoning_levels = native.models[0].supported_reasoning_levels.filter(level => level.effort !== 'ultra')
  assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement(), native), /Invalid native catalog/)
})

test('omitting native input preserves the legacy builder byte-for-byte', () => {
  const bundled = bundledFixture()
  const advertised = exactAdvertisement()
  const original = JSON.stringify(api.buildCatalog(bundled, advertised))
  assert.equal(JSON.stringify(api.buildCatalog(bundled, advertised, undefined)), original)
  assert.equal(original, JSON.stringify({ models: [...bundled.models, {
    ...bundled.models[0], slug: 'cx/gpt-6.1-sol', display_name: 'cx/gpt-6.1-sol', context_window: 1050000, max_context_window: 1050000,
    auto_compact_token_limit: null, prefer_websockets: false, visibility: 'list',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort, description: `Gateway-supported ${effort} reasoning` })),
  }] }))
})


test('restricting provider efforts never promotes Ultra to the default wire effort', () => {
  const native = nativeFixture()
  native.models[0].supported_reasoning_levels.reverse()
  const exact = api.buildCatalog(bundledFixture(), exactAdvertisement({ supportedReasoningEfforts: ['xhigh'] }), native).models.at(-1)
  assert.deepEqual(exact.supported_reasoning_levels.map(level => level.effort), ['ultra', 'xhigh'])
  assert.equal(exact.default_reasoning_level, 'xhigh')
})


test('an explicit top-level provider reasoning false also denies the exact native override', () => {
  assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement({ reasoning: false }), nativeFixture()), /No compatible/)
  const other = { data: [{ id: 'cx/gpt-5.6-sol', context_length: 1000, reasoning: false }] }
  assert.throws(() => api.buildCatalog(bundledFixture(), other, nativeFixture()), /No compatible/)
  assert.throws(() => api.buildCatalog(bundledFixture(), other), /No compatible/)
})


test('sparse native and provider effort lists are malformed and fail closed', () => {
  const native = nativeFixture()
  native.models[0].supported_reasoning_levels.length++
  assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement(), native), /Invalid native catalog/)
  const efforts = ['xhigh']
  efforts.length++
  assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement({ supportedReasoningEfforts: efforts }), nativeFixture()), /No compatible/)
})


test('native CLI Max resolution uses a supported distinct Max without xhigh restriction', () => {
  const native = nativeFixture()
  native.models[0].slug = 'gpt-6-sol'
  delete native.models[0].multi_agent_reasoning_effort
  native.models[0].supported_reasoning_levels.splice(3, 0, { effort: 'max', description: 'distinct Max fixture' })
  const output = api.buildCatalog(bundledFixture(), { data: [{ id: 'cx/gpt-6-sol', context_length: 1000, supportedReasoningEfforts: ['max'] }] }, native)
  assert.deepEqual(output.models.at(-1).supported_reasoning_levels.map(level => level.effort), ['max', 'ultra'])
  assert.equal(output.models.at(-1).multi_agent_reasoning_effort, undefined)
})

test('all exact audited native Ultra bases use their own complete descriptors without requiring Sol 6.1', () => {
  const native = nativeFixture()
  native.models[0].slug = 'gpt-6-astra'
  native.models[0].base_instructions = 'distinct astra fixture instructions'
  const output = api.buildCatalog(bundledFixture(), { data: [{ id: 'cx/gpt-6-astra', context_length: 1000 }] }, native)
  assert.deepEqual(output.models.at(-1), { ...native.models[0], slug: 'cx/gpt-6-astra', display_name: 'cx/gpt-6-astra',
    context_window: 1000, max_context_window: 1000, auto_compact_token_limit: null, prefer_websockets: false, visibility: 'list' })
})


test('false update support preserves literal Ultra selection and the original native flag', () => {
  for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra']) {
    const native = nativeFixture()
    Object.assign(native.models[0], { slug, supports_reasoning_effort_updates: false, multi_agent_reasoning_effort: null })
    native.models[0].supported_reasoning_levels.splice(3, 0, { effort: 'max', description: 'native Max' })
    const output = api.buildCatalog(bundledFixture(), { data: [{ id: `cx/${slug}`, context_length: 1000 }] }, native)
    assert.equal(output.models.at(-1).supports_reasoning_effort_updates, false)
    assert.ok(output.models.at(-1).supported_reasoning_levels.some(level => level.effort === 'ultra'))
  }
})


test('invalid native defaults fail per model without poisoning other exact eligible descriptors', () => {
  const native = nativeFixture()
  native.models.push({ ...native.models[0], slug: 'gpt-6-astra', default_reasoning_level: 'not-supported' }, null)
  const output = api.buildCatalog(bundledFixture(), { data: [...exactAdvertisement().data, { id: 'cx/gpt-6-astra', context_length: 1000 }] }, native)
  assert.equal(output.models.some(model => model.slug === 'cx/gpt-6-astra'), false)
  assert.ok(output.models.some(model => model.slug === 'cx/gpt-6.1-sol'))
})


test('unbound variants cannot borrow provider-only Ultra even when native metadata is enabled', () => {
  const id = 'cx/gpt-6.1-sol[1m]'
  const output = api.buildCatalog(bundledFixture(), { data: [...exactAdvertisement().data,
    { id, context_length: 1000, supportedReasoningEfforts: ['max', 'ultra'] }] }, nativeFixture())
  assert.deepEqual(output.models.find(model => model.slug === id).supported_reasoning_levels.map(level => level.effort), ['max'])
})


test('malformed native multi-agent effort cannot become an eligible fallback', () => {
  const native = nativeFixture()
  native.models[0].multi_agent_reasoning_effort = { value: 'xhigh' }
  assert.throws(() => api.buildCatalog(bundledFixture(), exactAdvertisement(), native), /Invalid native catalog/)
})


test('native resolver mirrors declared supported value then Max then last non-Ultra ordering', () => {
  const resolve = require('../src/server/runtimeLocalUltra.mjs').nativeUltraWireEffort
  for (const [declared, efforts, expected] of [
    ['high', ['low', 'high', 'max', 'ultra'], 'high'],
    ['xhigh', ['low', 'high', 'max', 'ultra'], 'max'],
    ['ultra', ['low', 'high', 'max', 'ultra'], 'max'],
    [null, ['ultra', 'high', 'low'], 'low'],
    [undefined, ['ultra', 'low', 'high'], 'high'],
  ]) {
    assert.equal(resolve({ ...nativeFixture().models[0], multi_agent_reasoning_effort: declared,
      default_reasoning_level: 'high', supported_reasoning_levels: efforts.map(effort => ({ effort })) }), expected)
  }
})

test('native duplicates fail per ID without poisoning a different valid descriptor', () => {
  const native = nativeFixture(), duplicate = { ...native.models[0], slug: 'gpt-6-astra' }
  native.models.push(duplicate, duplicate, null, false)
  const output = api.buildCatalog(bundledFixture(), { data: [...exactAdvertisement().data, { id: 'cx/gpt-6-astra', context_length: 1000 }] }, native)
  assert.ok(output.models.some(model => model.slug === 'cx/gpt-6.1-sol'))
  assert.equal(output.models.some(model => model.slug === 'cx/gpt-6-astra'), false)
})


test('audited one-million and review bindings clone only exact reviewed native descriptors', () => {
  const native = nativeFixture()
  const originals = ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra'].map(slug => ({ ...native.models[0], slug }))
  native.models.push(...originals)
  const bindings = new Map([
    ['cx/gpt-6-astra[1m]', 'gpt-6-astra'], ['cx/gpt-6-sol[1m]', 'gpt-6-sol'],
    ['cx/gpt-5.6-sol[1m]', 'gpt-5.6-sol'], ['cx/gpt-5.6-sol-review', 'gpt-5.6-sol'],
    ['cx/gpt-5.6-terra[1m]', 'gpt-5.6-terra'], ['cx/gpt-5.6-terra-review', 'gpt-5.6-terra'],
  ])
  const advertised = { data: [...exactAdvertisement().data, ...[...bindings].map(([id]) => ({ id, context_length: 872000 }))] }
  const output = api.buildCatalog(bundledFixture(), advertised, native)
  for (const [id, slug] of bindings) {
    const model = output.models.find(model => model.slug === id)
    assert.ok(model, id)
    assert.deepEqual(model, { ...native.models.find(model => model.slug === slug), slug: id, display_name: id,
      context_window: 872000, max_context_window: 872000, auto_compact_token_limit: null, prefer_websockets: false, visibility: 'list' })
  }
})


test('duplicate advertised audited IDs cannot trust a first permissive row', () => {
  const native = nativeFixture()
  native.models.push({ ...native.models[0], slug: 'gpt-6-astra' })
  const output = api.buildCatalog(bundledFixture(), { data: [...exactAdvertisement().data,
    { id: 'cx/gpt-6-astra', context_length: 1000, supportedReasoningEfforts: ['xhigh'] },
    { id: 'cx/gpt-6-astra', context_length: 1000, reasoning: false }] }, native)
  assert.equal(output.models.some(model => model.slug === 'cx/gpt-6-astra'), false)
})
