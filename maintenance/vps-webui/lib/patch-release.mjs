import { createHash } from 'node:crypto';
import { verifiedRoutes } from './capabilities.mjs';

export const BASELINE = {
  sourceCommit: '4112769f178189567035a1a440c57753c1b66781',
  files: {
    'app/dist/index.html': '31e4c258bfee1672a5db93033add5ff88611288031e66f36d813be9ce8e037a5',
    'app/dist/sw.js': '56279ab8b293c749156fa28ee55c55c00e4917f0cc815b3878502d80df119b70',
    'app/dist/assets/index-Be40V98R.js': 'e839409719f0b36f52789b29208c8f33a7eba805fcf2db1b1c2055d719a23c3f',
    'app/dist-cli/index.js': '5fb85a83709870da2d00063470a7126c9c356fc9c9cf0ca9fa7db3e84bf41b5e',
    'ninerouter-models.json': '99ef6d395179a61a715e1b7411c8e2741617974a8ec5ec7f0ca24283a51c0c03',
    'release-proof.json': '06083bc28ca303670909b5a5e512a754910c48c95b0716a35b5d8a2376657511',
  },
};

export const sha256 = body => createHash('sha256').update(body).digest('hex');

export function replaceOnce(source, expected, replacement) {
  if (source.split(expected).length !== 2) throw new Error(`Patch anchor is not unique: ${expected.slice(0, 90)}`);
  return source.replace(expected, replacement);
}

export function replaceSection(source, first, next, replacement) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start + first.length);
  if (start < 0 || end < 0 || source.indexOf(first, start + first.length) >= 0) throw new Error(`Section not found uniquely: ${first}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

export function patchBackend(source) {
  const imports = `import {
  applyVerifiedCapabilities as __maintenanceApplyCapabilities,
  createProviderDiscovery as __maintenanceCreateDiscovery,
  discoveryHttpStatus as __maintenanceDiscoveryStatus,
  callAppServer as __maintenanceCall,
  runControlRpc as __maintenanceRunControlRpc
} from "./maintenance-runtime.mjs";
`;
  source = replaceOnce(source, '#!/usr/bin/env node\n', `#!/usr/bin/env node\n${imports}`);
  source = replaceOnce(source, 'async function readProviderBackedModelIds(appServer) {', `const __maintenanceDiscovery = __maintenanceCreateDiscovery();
async function readProviderBackedModelIds(appServer) {
  return __maintenanceDiscovery.read(appServer, signal => __maintenanceDiscoverProviderModels(appServer, signal));
}
async function __maintenanceDiscoverProviderModels(appServer, __maintenanceSignal) {`);
  const discoveryStart = source.indexOf('async function __maintenanceDiscoverProviderModels(');
  const discoveryEnd = source.indexOf('async function readProviderModelIdsForProvider(', discoveryStart);
  if (discoveryStart < 0 || discoveryEnd < 0) throw new Error('Provider discovery section not found');
  let discovery = source.slice(discoveryStart, discoveryEnd);
  discovery = replaceOnce(discovery, 'const configPayload = asRecord6(await appServer.rpc("config/read", {}));',
    'const configPayload = asRecord6(await appServer.rpc("config/read", {}, { signal: __maintenanceSignal }));');
  discovery = replaceOnce(discovery, 'signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS)\n    });\n  } catch (error) {\n    logProviderModelDiscoveryWarning',
    'signal: AbortSignal.any([AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS), __maintenanceSignal])\n    });\n  } catch (error) {\n    logProviderModelDiscoveryWarning');
  discovery = replaceOnce(discovery, 'models: normalizeProviderModelMetadata(payload).map((model) => ({',
    'models: __maintenanceApplyCapabilities(normalizeProviderModelMetadata(payload), { providerId, baseUrl, payload }).map((model) => ({');
  source = source.slice(0, discoveryStart) + discovery + source.slice(discoveryEnd);
  source = replaceSection(source, '  async call(method, params) {', '  async ensureInitialized() {', `  async call(method, params, options = {}) {
    return __maintenanceCall(this, method, params, options);
  }
`);
  source = replaceOnce(source, '  async rpc(method, params) {\n    const submission', `  async rpc(method, params, options = {}) {
    return __maintenanceRunControlRpc(method, signal => this.__maintenanceRpc(method, params, { signal }), options);
  }
  async __maintenanceRpc(method, params, options = {}) {
    const submission`);
  source = replaceOnce(source, 'const result = await this.call(method, params);', 'const result = await this.call(method, params, options);');
  const begin = '      if (req.method === "GET" && url.pathname === "/codex-api/provider-models") {';
  const end = '      if (req.method === "GET" && url.pathname === "/codex-api/workspace-roots-state") {';
  const start = source.indexOf(begin), finish = source.indexOf(end, start);
  if (start < 0 || finish < 0) throw new Error('Provider HTTP route not found');
  let section = source.slice(start, finish);
  section = section.replaceAll('setJson4(res,', '__maintenanceRespond(res,');
  section = replaceOnce(section, begin, `${begin}
        const __maintenanceRespond = (response, status, body) => setJson4(response, __maintenanceDiscoveryStatus(body, status), body);`);
  source = source.slice(0, start) + section + source.slice(finish);
  source = source.replace('//# sourceMappingURL=index.js.map', '// Original source map retained as baseline-only; maintenance sources are separate modules.');
  return source;
}

export function patchFrontend(source, manifest) {
  const efforts = Object.fromEntries(verifiedRoutes(manifest).map(route => [route.id, route.reasoningOptions]));
  source = replaceOnce(source, 'const Mu=[', `const __maintenanceVerifiedEfforts=${JSON.stringify(efforts)};const Mu=[`);
  source = replaceSection(source, 'function Gu(e,t){', 'function Vd(', `function Gu(e,t){
  if(t?.supportsReasoning===false)return[];
  const allowed=[...Mu,"ultra"],id=Df(e);
  const explicit=t?.reasoningOptions?.filter(value=>typeof value==="string"&&allowed.includes(value));
  if(Array.isArray(explicit)&&(explicit.length||t.reasoningSource==="provider-catalog"||t.reasoningSource==="gateway-verified"||id.startsWith("cx/")))return[...new Set(explicit)];
  const verified=__maintenanceVerifiedEfforts[id];
  if(!t&&Array.isArray(verified))return[...verified];
  return !id.startsWith("cx/")&&Ff(e)?[...Mu,"ultra"]:[...Mu];
}`);
  source = replaceOnce(source, 'function uI(e,t,n){return t?n?Gu(e,n).includes(t):t==="ultra"?Ff(e):Mu.includes(t):!0}',
    'function uI(e,t,n){return t?Gu(e,n).includes(t):!0}');
  source = replaceOnce(source, 'Ff(r.selectedModel)&&A.push({value:"ultra",label:"Ultra"});',
    'A.push({value:"ultra",label:"Ultra"});');
  return source;
}

export function patchCatalog(catalog, manifest) {
  const output = structuredClone(catalog);
  const verified = new Map(verifiedRoutes(manifest).map(route => [route.id, route]));
  for (const model of output.models) {
    if (!verified.has(model.slug)) continue;
    if (!model.supported_reasoning_levels.some(level => level.effort === 'ultra')) {
      model.supported_reasoning_levels.push({ effort: 'ultra', description: 'Ultra verified on this exact gateway route' });
    }
  }
  return output;
}
