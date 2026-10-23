import { createHash } from 'node:crypto';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function advertisedFingerprint(row) {
  const selected = {};
  for (const key of ['id', 'capabilities', 'reasoning', 'context_length', 'max_completion_tokens',
    'supportedReasoningEfforts', 'supported_reasoning_efforts', 'thinkingLevels']) {
    if (row[key] !== undefined) selected[key] = row[key];
  }
  return createHash('sha256').update(stableJson(selected)).digest('hex');
}

export function explicitEfforts(row) {
  const values = row.supportedReasoningEfforts ?? row.supported_reasoning_efforts ?? row.thinkingLevels;
  if (!Array.isArray(values)) return null;
  return [...new Set(values.flatMap(value => {
    const effort = typeof value === 'string' ? value : value?.reasoningEffort ?? value?.reasoning_effort;
    return EFFORTS.includes(effort) ? [effort] : [];
  }))];
}

export function ultraCandidates(advertised, catalog) {
  const native = new Map(catalog.models.filter(row => !row.slug.startsWith('cx/')).map(row => [row.slug, row]));
  const existing = new Map(catalog.models.map(row => [row.slug, row]));
  const seen = new Set();
  const result = [];
  for (const row of advertised.data ?? []) {
    if (typeof row.id !== 'string' || !row.id.startsWith('cx/') || seen.has(row.id)) continue;
    seen.add(row.id);
    if ((row.capabilities?.reasoning ?? row.reasoning) === false) continue;
    const explicit = explicitEfforts(row);
    if (explicit && !explicit.includes('ultra')) continue;
    const slug = row.id.slice(3).replace(/\[1m\]$/, '').replace(/-review$/, '');
    const family = /^gpt-6(?:\.1)?-(sol|luna)$/.exec(slug);
    const template = native.get(slug) ?? (family ? native.get(`gpt-5.6-${family[1]}`) : null);
    if (!explicit?.includes('ultra') && !template?.supported_reasoning_levels?.some(level => level.effort === 'ultra')) continue;
    if (!existing.has(row.id)) continue;
    result.push({ id: row.id, template: template?.slug ?? null, advertisedFingerprint: advertisedFingerprint(row),
      baselineEfforts: existing.get(row.id).supported_reasoning_levels.map(level => level.effort) });
  }
  return result;
}

export function verifiedRoutes(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.providerId !== 'ninerouter' || !Array.isArray(manifest.routes)) return [];
  return manifest.routes.filter(route => route && route.verified === true && route.outputMatched === true && route.httpStatus === 200 &&
    route.responseStatus === 'completed' && route.returnedEffort === 'ultra' &&
    typeof route.id === 'string' && route.id.startsWith('cx/') &&
    /^[a-f0-9]{64}$/.test(route.advertisedFingerprint ?? '') &&
    Array.isArray(route.reasoningOptions) && route.reasoningOptions.includes('ultra') &&
    route.reasoningOptions.every(effort => EFFORTS.includes(effort)));
}

export function applyCapabilities(models, { manifest, providerId, baseUrl, payload }) {
  if (providerId !== manifest?.providerId || baseUrl?.replace(/\/+$/, '') !== manifest?.baseUrl) return models;
  const verified = new Map(verifiedRoutes(manifest).map(route => [route.id, route]));
  const raw = new Map((payload?.data ?? payload?.models ?? []).filter(row => row && typeof row === 'object').map(row => [row.id, row]));
  return models.map(model => {
    if (model.supportsReasoning === false) return model;
    const row = raw.get(model.id);
    const proof = verified.get(model.id);
    const explicit = row ? explicitEfforts(row) : null;
    const valid = proof && row && advertisedFingerprint(row) === proof.advertisedFingerprint;
    if (explicit && !explicit.includes('ultra')) return model;
    if (!valid) {
      return model.reasoningOptions?.includes('ultra')
        ? { ...model, reasoningOptions: model.reasoningOptions.filter(effort => effort !== 'ultra') }
        : model;
    }
    return { ...model, reasoningOptions: [...new Set([...(explicit ?? model.reasoningOptions ?? []), 'ultra'])],
      reasoningSource: explicit ? 'provider-catalog' : 'gateway-verified' };
  });
}
