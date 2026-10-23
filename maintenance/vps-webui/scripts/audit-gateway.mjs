import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';

const root = fs.realpathSync('/opt/ninerouter/current');
const chunks = `${root}/runtime/.next/standalone/.next/server/chunks`;
const files = Object.fromEntries(['5330.js', '8499.js', '6100.js'].map(name => [name, fs.readFileSync(`${chunks}/${name}`, 'utf8')]));
const marker = 'function z(a,b){let c=(0,k.k)("codex",a);';
const start = files['5330.js'].indexOf(marker);
if (start < 0) throw new Error('Installed Codex effort normalizer changed');
const normalizer = files['5330.js'].slice(start, files['5330.js'].indexOf('function A(', start));
const levelStart = files['8499.js'].indexOf('72239:(a,b,c)=>');
const constantsStart = files['8499.js'].indexOf('let h=', levelStart);
const resolverStart = files['8499.js'].indexOf('function o(a,b)', constantsStart);
const resolverEndText = 'return!1===c.thinkingCanDisable&&(m=m.filter(a=>"none"!==a)),m}';
const resolverEnd = files['8499.js'].indexOf(resolverEndText, resolverStart) + resolverEndText.length;
if (levelStart < 0 || constantsStart < 0 || resolverStart < 0 || resolverEnd < resolverStart) throw new Error('Thinking-level resolver changed');
const solLevels = JSON.parse(files['6100.js'].match(/j=(\[[^\]]+\]),k=\{id:"codex"/)[1]);
const modelsStart = files['6100.js'].indexOf('models:[{id:"gpt-6.1-sol"') + 'models:'.length;
let quote = null, escaped = false, depth = 0, modelsEnd = -1;
for (let index = modelsStart; index < files['6100.js'].length; index++) {
  const c = files['6100.js'][index];
  if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
  if (c === '"' || c === "'") { quote = c; continue; }
  if (c === '[') depth++;
  if (c === ']' && --depth === 0) { modelsEnd = index + 1; break; }
}
if (modelsStart < 7 || modelsEnd < 0) throw new Error('Gateway model registry changed');
const registry = vm.runInNewContext(`(${files['6100.js'].slice(modelsStart, modelsEnd)})`, { j: solLevels }, { timeout: 1000 });
const glob = (pattern, value) => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(value);
const levels = vm.runInNewContext(`${files['8499.js'].slice(constantsStart, resolverStart)}${files['8499.js'].slice(resolverStart, resolverEnd)};o`, {
  d: { getCapabilitiesForModel: () => ({ reasoning: true, thinkingCanDisable: true, thinkingFormat: 'openai' }) },
  e: { gH: glob }, f: { pA: () => null }, g: { SM: () => registry },
}, { timeout: 1000 });
const normalize = vm.runInNewContext(`${normalizer};z`, { k: { k: levels }, u: model => registry.some(row => row.id === model && row.responsesLite) }, { timeout: 1000 });
const probes = JSON.parse(fs.readFileSync(new URL('../evidence/ultra-capabilities.json', import.meta.url), 'utf8'));
const routes = probes.routes.map(probe => {
  const row = registry.find(row => row.id === probe.id.slice(3));
  if (!row) throw new Error(`Registry entry missing: ${probe.id}`);
  const upstreamModel = row.upstreamModelId ?? row.id;
  return { id: probe.id, upstreamModel, advertisedExecutorEfforts: levels('codex', upstreamModel),
    requestedEffort: 'ultra', forwardedEffort: normalize(upstreamModel, 'ultra'), probeHttpStatus: probe.httpStatus };
});
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), gatewayRelease: root,
  files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, crypto.createHash('sha256').update(body).digest('hex')])),
  normalizer, executorUsesNormalizer: files['5330.js'].includes('b.reasoning.effort=z(b.model,b.reasoning.effort)'),
  executorDropsRequestedOutputLimit: files['5330.js'].includes('delete b.max_output_tokens'),
  conclusion: 'The five successful gpt-6 routes downgrade ultra to max. Older Sol/Terra retain ultra in the executor but the one permitted probe per route failed HTTP 400. No route is verified.', routes }, null, 2));
