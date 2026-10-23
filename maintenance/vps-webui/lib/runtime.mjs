import { readFileSync } from 'node:fs';
import { applyCapabilities } from './maintenance-capabilities.mjs';

export { callAppServer, runControlRpc, createProviderDiscovery, discoveryHttpStatus } from './maintenance-control-plane.mjs';

let manifest;
try {
  manifest = JSON.parse(readFileSync(new URL('../../ultra-capabilities.json', import.meta.url), 'utf8'));
} catch {
  // Fail closed: unavailable proof must never enable a new reasoning effort.
  manifest = null;
}

export function applyVerifiedCapabilities(models, options) {
  return applyCapabilities(models, { ...options, manifest });
}
