import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BASELINE, sha256, replaceOnce, patchBackend, patchFrontend, patchCatalog } from '../lib/patch-release.mjs';
import { advertisedFingerprint } from '../lib/capabilities.mjs';

const base = fs.realpathSync('/opt/codex-mobile/current');
const frontend = fs.readFileSync(`${base}/app/dist/assets/index-Be40V98R.js`, 'utf8');
const backend = fs.readFileSync(`${base}/app/dist-cli/index.js`, 'utf8');
const row = { id: 'cx/gpt-6.1-sol', capabilities: { reasoning: true } };
const manifest = { schemaVersion: 1, providerId: 'ninerouter', baseUrl: 'http://127.0.0.1:20128/v1', routes: [{
  id: row.id, verified: true, outputMatched: true, httpStatus: 200, responseStatus: 'completed', returnedEffort: 'ultra',
  advertisedFingerprint: advertisedFingerprint(row), reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
}] };
function helpers(source) {
  const start = source.indexOf('const __maintenanceVerifiedEfforts=');
  const end = source.indexOf('const cI=', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)};({efforts:Gu,supported:uI})`);
}
const plain = value => JSON.parse(JSON.stringify(value));

test('all target artifact baseline hashes still match', () => {
  for (const [relative, expected] of Object.entries(BASELINE.files)) assert.equal(sha256(fs.readFileSync(`${base}/${relative}`)), expected, relative);
});
test('nonunique or missing patch anchors abort instead of guessing', () => {
  assert.throws(() => replaceOnce('two two', 'two', 'new')); assert.throws(() => replaceOnce('one', 'missing', 'new'));
});
test('backend overlay adds bounded RPCs and HTTP status handling', () => {
  const patched = patchBackend(backend);
  assert.ok(patched.includes('return __maintenanceCall(this, method, params, options);'));
  assert.ok(patched.includes('signal: __maintenanceSignal'));
  assert.ok(patched.includes('__maintenanceDiscoveryStatus(body, status)'));
  assert.ok(patched.includes('async __maintenanceRpc(method, params, options = {})'));
});
test('frontend renders ultra from effective capabilities rather than the Astra gate', () => {
  const patched = patchFrontend(frontend, manifest);
  assert.ok(!patched.includes('Ff(r.selectedModel)&&A.push({value:"ultra",label:"Ultra"});'));
  assert.equal(helpers(patched).supported(row.id, 'ultra', { reasoningOptions: ['low', 'ultra'] }), true);
});
test('verified Sol selection survives absent metadata during refresh/resume', () => {
  const functions = helpers(patchFrontend(frontend, manifest));
  assert.equal(functions.supported(row.id, 'ultra'), true);
  assert.deepEqual(plain(functions.efforts(row.id)), manifest.routes[0].reasoningOptions);
});
test('authoritative metadata can revoke the embedded verified fallback', () => {
  const functions = helpers(patchFrontend(frontend, manifest));
  assert.equal(functions.supported(row.id, 'ultra', { reasoningOptions: ['low', 'medium'], reasoningSource: 'codex-family-fallback' }), false);
});
test('unverified Astra aliases do not gain ultra while metadata loads', () => {
  const functions = helpers(patchFrontend(frontend, { ...manifest, routes: [] }));
  assert.equal(functions.supported('cx/gpt-6-astra', 'ultra'), false);
  assert.equal(functions.supported('cx/gpt-6-astra[1m]', 'ultra'), false);
});
test('unrelated native Astra fallback is preserved', () => {
  const functions = helpers(patchFrontend(frontend, { ...manifest, routes: [] }));
  assert.equal(functions.supported('gpt-6-astra', 'ultra'), true);
});
test('non-reasoning models and explicit empty lists remain disabled', () => {
  const functions = helpers(patchFrontend(frontend, manifest));
  assert.deepEqual(plain(functions.efforts(row.id, { supportsReasoning: false })), []);
  assert.deepEqual(plain(functions.efforts(row.id, { reasoningOptions: [], reasoningSource: 'provider-catalog' })), []);
});
test('normal and collaboration-mode allowlists retain ultra', () => {
  const patched = patchFrontend(frontend, manifest);
  assert.ok(patched.includes('Xd=["none","minimal","low","medium","high","xhigh","max","ultra"]'));
  assert.ok(patched.includes('reasoning_effort:'));
  assert.ok(patchBackend(backend).includes('const allowed = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];'));
});
test('catalog patch changes only verified alias effort lists', () => {
  const catalog = JSON.parse(fs.readFileSync(`${base}/ninerouter-models.json`, 'utf8'));
  const patched = patchCatalog(catalog, manifest);
  for (let i = 0; i < catalog.models.length; i++) {
    const before = structuredClone(catalog.models[i]), after = structuredClone(patched.models[i]);
    if (before.slug === row.id) {
      assert.ok(after.supported_reasoning_levels.some(level => level.effort === 'ultra'));
      delete before.supported_reasoning_levels; delete after.supported_reasoning_levels;
    }
    assert.deepEqual(after, before);
  }
});
test('live failed verification never changes runtime catalog', () => {
  const evidence = JSON.parse(fs.readFileSync(new URL('../evidence/ultra-capabilities.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(`${base}/ninerouter-models.json`, 'utf8'));
  assert.deepEqual(patchCatalog(catalog, evidence), catalog);
});
