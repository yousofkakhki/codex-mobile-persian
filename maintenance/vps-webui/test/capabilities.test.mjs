import test from 'node:test';
import assert from 'node:assert/strict';
import { advertisedFingerprint, explicitEfforts, verifiedRoutes, applyCapabilities, ultraCandidates } from '../lib/capabilities.mjs';

const row = { id: 'cx/gpt-6-astra', capabilities: { reasoning: true }, context_length: 272000 };
const model = { id: row.id, supportsReasoning: true, reasoningOptions: ['low', 'high'], reasoningSource: 'codex-family-fallback' };
const proof = () => ({ ...row, verified: true, httpStatus: 200, responseStatus: 'completed', returnedEffort: 'ultra',
  outputMatched: true, advertisedFingerprint: advertisedFingerprint(row), reasoningOptions: ['low', 'high', 'ultra'] });
const manifest = () => ({ schemaVersion: 1, providerId: 'ninerouter', baseUrl: 'http://127.0.0.1:20128/v1', routes: [proof()] });
const apply = (man = manifest(), raw = row, selected = model, options = {}) => applyCapabilities([selected], {
  manifest: man, providerId: 'ninerouter', baseUrl: 'http://127.0.0.1:20128/v1/', payload: { data: [raw] }, ...options,
})[0];

test('fingerprint is deterministic across property ordering', () => {
  assert.equal(advertisedFingerprint(row), advertisedFingerprint({ context_length: 272000, capabilities: { reasoning: true }, id: row.id }));
});
test('fingerprint ignores unrelated discovery timestamps', () => assert.equal(advertisedFingerprint(row), advertisedFingerprint({ ...row, discoveredAt: 'later' })));
test('explicit effort shapes normalize and deduplicate', () => assert.deepEqual(explicitEfforts({ thinkingLevels: ['low', { reasoning_effort: 'ultra' }, 'low', 'invalid'] }), ['low', 'ultra']));
test('explicit empty capability lists remain explicit', () => assert.deepEqual(explicitEfforts({ supportedReasoningEfforts: [] }), []));
test('malformed or missing manifests fail closed', () => {
  for (const value of [null, {}, { ...manifest(), routes: {} }, { ...manifest(), schemaVersion: 2 }]) assert.deepEqual(verifiedRoutes(value), []);
});
for (const [name, change] of Object.entries({
  downgraded: { returnedEffort: 'max' }, noEcho: { returnedEffort: null }, incomplete: { responseStatus: 'incomplete' },
  unsuccessful: { httpStatus: 400 }, unverified: { verified: false }, wrongOutput: { outputMatched: false },
})) test(`route is not verified when ${name}`, () => assert.equal(verifiedRoutes({ ...manifest(), routes: [{ ...proof(), ...change }] }).length, 0));
test('matching exact route gains ultra and truthful provenance', () => {
  assert.deepEqual(apply().reasoningOptions, ['low', 'high', 'ultra']);
  assert.equal(apply().reasoningSource, 'gateway-verified');
});
test('different endpoint cannot reuse verification', () => assert.deepEqual(apply(manifest(), row, model, { baseUrl: 'https://different.example/v1' }), model));
test('different provider cannot reuse verification', () => assert.deepEqual(apply(manifest(), row, model, { providerId: 'other' }), model));
test('alias verification does not generalize to extended context', () => assert.deepEqual(apply(manifest(), { ...row, id: `${row.id}[1m]` }, { ...model, id: `${row.id}[1m]` }).reasoningOptions, ['low', 'high']));
test('provider fingerprint drift does not promote ultra', () => assert.deepEqual(apply(manifest(), { ...row, context_length: 1000000 }).reasoningOptions, ['low', 'high']));
test('non-reasoning models stay disabled', () => assert.deepEqual(apply(manifest(), row, { ...model, supportsReasoning: false, reasoningOptions: [] }).reasoningOptions, []));
test('explicit provider restriction wins over local proof', () => assert.deepEqual(apply(manifest(), { ...row, thinkingLevels: ['low'] }, { ...model, reasoningOptions: ['low'] }).reasoningOptions, ['low']));
test('unverified advertised ultra is not silently enabled', () => assert.deepEqual(apply({ ...manifest(), routes: [] }, row, { ...model, reasoningOptions: ['low', 'ultra'] }).reasoningOptions, ['low']));
test('candidate enumeration requires exact installed alias and ultra-capable template', () => {
  const catalog = { models: [{ slug: 'gpt-6-astra', supported_reasoning_levels: [{ effort: 'ultra' }] },
    { slug: row.id, supported_reasoning_levels: [{ effort: 'low' }] }] };
  assert.equal(ultraCandidates({ data: [row, row, { ...row, id: 'cx/gpt-6-astra[1m]' }] }, catalog).length, 1);
  assert.equal(ultraCandidates({ data: [{ ...row, capabilities: { reasoning: false } }] }, catalog).length, 0);
});
