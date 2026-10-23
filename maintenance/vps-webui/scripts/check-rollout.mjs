// Read-only guard: this script never installs files, changes symlinks, or restarts services.
import fs from 'node:fs/promises';
import { verifyRelease } from '../lib/release-integrity.mjs';
import { verifiedRoutes } from '../lib/capabilities.mjs';

const read = async relative => JSON.parse(await fs.readFile(new URL(relative, import.meta.url), 'utf8'));
const build = await read('../.work/build-result.json');
const integrity = await verifyRelease(build);
const blockers = [];
if (!build.deployable || !integrity.verifiedCount) blockers.push(build.reason ?? 'No exact route has verified genuine ultra support');
const integration = await read('../evidence/integration-report.json').catch(() => null);
if (!integration?.passed || integration.stage !== build.stage || integration.checksumManifestSha256 !== integrity.checksumManifestSha256) {
  blockers.push('This exact candidate has not passed isolated full-server integration');
}
if (!blockers.length) {
  const manifest = JSON.parse(await fs.readFile(`${build.stage}/ultra-capabilities.json`, 'utf8'));
  const audit = await read('../evidence/gateway-audit.json');
  const gateway = await fs.realpath('/opt/ninerouter/current');
  const { sha256 } = await import('../lib/patch-release.mjs');
  if (audit.gatewayRelease !== gateway || !audit.executorUsesNormalizer) blockers.push('Gateway verification no longer matches the running release');
  for (const [file, hash] of Object.entries(audit.files)) {
    const current = await fs.readFile(`${gateway}/runtime/.next/standalone/.next/server/chunks/${file}`);
    if (sha256(current) !== hash) blockers.push(`Gateway source changed since audit: ${file}`);
  }
  for (const route of verifiedRoutes(manifest)) {
    if (audit.routes.find(row => row.id === route.id)?.forwardedEffort !== 'ultra') blockers.push(`Gateway downgrades or cannot confirm ultra: ${route.id}`);
  }
}
if (!blockers.length) {
  async function rpc(method, params = {}) {
    const response = await fetch('http://127.0.0.1:5901/codex-api/rpc', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok || body.error || !body.result) throw new Error(`Cannot establish idle state: ${method}`);
    return body.result;
  }
  const loaded = await rpc('thread/loaded/list');
  if (!Array.isArray(loaded.data)) throw new Error('Unknown loaded-thread response; refusing rollout');
  for (const threadId of loaded.data) {
    const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
    if (thread?.status?.type !== 'idle') blockers.push('A loaded conversation is active or its state is unknown');
  }
}
console.log(JSON.stringify({ integrityPassed: true, rolloutAllowed: blockers.length === 0, readOnly: true, blockers }));
if (blockers.length) process.exitCode = 2;
