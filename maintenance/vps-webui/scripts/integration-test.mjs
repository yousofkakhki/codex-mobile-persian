import fs from 'node:fs/promises';
import { readlinkSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { sha256 } from '../lib/patch-release.mjs';

if (process.getuid() !== 0 || readlinkSync('/proc/self/ns/net') === readlinkSync('/proc/1/ns/net')) {
  throw new Error('Run this test inside sudo unshare --net; never start fixture listeners in the host network namespace');
}
execFileSync('ip', ['link', 'set', 'lo', 'up']);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = JSON.parse(await fs.readFile(path.join(repo, '.work/build-result.json'), 'utf8'));
const work = await fs.mkdtemp(path.join(repo, '.work/integration-'));
const isolatedState = path.join(work, 'codex-state');
await fs.mkdir(isolatedState);
const configPath = path.join(isolatedState, 'config.toml');
await fs.writeFile(configPath, 'model = "cx/gpt-6-astra"\nmodel_provider = "ninerouter"\n');
const controlPath = path.join(work, 'fixture-control.json');
await fs.writeFile(controlPath, '{}');
await fs.chmod(path.join(repo, 'test/fixtures/fake-codex.mjs'), 0o755);
let gatewayMode = 'valid';
const advertised = { data: ['cx/gpt-6-astra', 'cx/gpt-6.1-sol'].map(id => ({ id, capabilities: { reasoning: true, tools: true }, context_length: 272000 })) };
const gateway = http.createServer((request, response) => {
  if (request.url !== '/v1/models') { response.writeHead(500); response.end('Inference is forbidden in this test'); return; }
  if (gatewayMode === 'invalid') { response.writeHead(502, { 'Content-Type': 'text/html' }); response.end('<html>502 Bad Gateway</html>'); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(advertised));
});
await new Promise(resolve => gateway.listen(20128, '127.0.0.1', resolve));
const childEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC',
  CODEX_HOME: isolatedState, CODEXUI_CODEX_COMMAND: path.join(repo, 'test/fixtures/fake-codex.mjs'),
  CODEXUI_MODEL_CATALOG_JSON: path.join(build.stage, 'ninerouter-models.json'),
  MAINTENANCE_TEST_CONTROL: controlPath };
const backend = spawn(path.join(build.base, 'runtime/bin/node'), [path.join(build.stage, 'app/dist-cli/index.js'),
  '--port', '5902', '--no-password', '--no-login', '--no-tunnel', '--no-open', '--no-memories',
  '--sandbox-mode', 'danger-full-access', '--approval-policy', 'never'], { cwd: work, env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let serverLog = '';
backend.stdout.on('data', data => { serverLog += data; });
backend.stderr.on('data', data => { serverLog += data; });
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, detail = {}) => { const result = { name, passed: true, ...detail }; checks.push(result); console.log(JSON.stringify(result)); };
async function get(route, init = {}) {
  const at = Date.now();
  const response = await fetch(`http://127.0.0.1:5902${route}`, { ...init, signal: AbortSignal.timeout(12000) });
  const body = await response.text();
  return { response, body, ms: Date.now() - at };
}
async function rpc(method) {
  const result = await get('/codex-api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: {} }) });
  return { ...result, data: JSON.parse(result.body) };
}
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (backend.exitCode !== null) throw new Error(`Fixture server exited ${backend.exitCode}: ${serverLog.slice(-2000)}`);
    try { const response = await fetch('http://127.0.0.1:5902/', { signal: AbortSignal.timeout(500) }); if (response.ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `Fixture server did not become ready: ${serverLog.slice(-2000)}`);
  const index = await get('/'); assert.equal(index.response.status, 200);
  assert.ok(index.body.includes(`/assets/${build.asset}`)); check('staged HTML references the new content-addressed asset');
  const asset = await get(`/assets/${build.asset}`); assert.equal(asset.response.status, 200);
  assert.equal(sha256(asset.body), sha256(await fs.readFile(path.join(build.stage, 'app/dist/assets', build.asset))));
  check('actual HTTP response serves the staged frontend bytes');
  const sw = await get('/sw.js'); assert.ok(sw.body.includes('codexweb-shell-ultra-')); check('service-worker cache version changed');
  const before = await get('/codex-api/provider-models'); const provider = JSON.parse(before.body);
  assert.equal(before.response.status, 200); assert.equal(provider.models.length, 2); assert.equal(provider.stale, false);
  assert.ok(provider.models.every(model => !model.reasoningOptions.includes('ultra')));
  check('provider route remains usable and does not promote unverified ultra');
  const warmedAt = Date.now();
  const models = await rpc('model/list'); assert.equal(models.response.status, 200);
  assert.ok(models.data.result.data.some(model => model.id === 'cx/gpt-6-astra')); check('model/list traverses the patched RPC bridge');
  await fs.writeFile(controlPath, JSON.stringify({ delayModels: 8500 }));
  const stalledModels = await rpc('model/list');
  assert.equal(stalledModels.response.status, 502); assert.match(stalledModels.data.error, /model\/list timed out after 8000ms/);
  assert.ok(stalledModels.ms >= 7800 && stalledModels.ms < 10000); check('model/list timeout surfaces cleanly at eight seconds', { ms: stalledModels.ms });
  await fs.writeFile(controlPath, JSON.stringify({ stallConfig: true }));
  const stalledConfig = await rpc('config/read');
  assert.equal(stalledConfig.response.status, 502); assert.match(stalledConfig.data.error, /config\/read timed out after 8000ms/);
  assert.ok(stalledConfig.ms >= 7800 && stalledConfig.ms < 10000);
  check('config/read timeout is bounded', { ms: stalledConfig.ms });
  await fs.writeFile(controlPath, '{}');
  const afterLate = await rpc('model/list'); assert.ok(afterLate.data.result.data.length > 0);
  check('late cancelled reply does not corrupt later RPC results');
  const remaining = Math.max(0, 30200 - (Date.now() - warmedAt));
  await delay(remaining);
  gatewayMode = 'invalid';
  const stale = await get('/codex-api/provider-models'); const staleBody = JSON.parse(stale.body);
  assert.equal(stale.response.status, 200); assert.equal(staleBody.stale, true); assert.equal(staleBody.models.length, 2);
  check('HTML 502 retains last-successful catalog with stale indicator');
  await fs.writeFile(controlPath, JSON.stringify({ stallConfig: true }));
  await fs.appendFile(configPath, '# fixture provider configuration changed\n');
  const cold = await get('/codex-api/provider-models'); const coldBody = JSON.parse(cold.body);
  assert.equal(cold.response.status, 503); assert.equal(coldBody.code, 'PROVIDER_MODELS_UNAVAILABLE'); assert.deepEqual(coldBody.data, []);
  assert.ok(cold.ms < 10000); check('changed configuration cannot reuse stale data and cold stall returns 503', { ms: cold.ms });
  const report = { testedAt: new Date().toISOString(), isolatedNetworkNamespace: true, realInferenceCalls: 0,
    realCredentialsUsed: false, stage: build.stage, serverSha256: sha256(await fs.readFile(path.join(build.stage, 'app/dist-cli/index.js'))),
    checksumManifestSha256: sha256(await fs.readFile(path.join(build.stage, 'SHA256SUMS'))), passed: true, checks };
  const reportPath = path.join(repo, 'evidence/integration-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  // sudo may inherit a restrictive umask; the safe report belongs to the repo owner.
  const owner = await fs.stat(repo);
  await fs.chown(reportPath, owner.uid, owner.gid);
  await fs.chmod(reportPath, 0o644);
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: 'evidence/integration-report.json' }));
} catch (error) {
  console.error(JSON.stringify({ failed: true, message: error.message, serverTail: serverLog.slice(-2000) }));
  process.exitCode = 1;
} finally {
  try { process.kill(-backend.pid, 'SIGTERM'); } catch {}
  await delay(300);
  try { process.kill(-backend.pid, 'SIGKILL'); } catch {}
  gateway.closeAllConnections(); gateway.close();
}
