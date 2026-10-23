import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ultraCandidates, verifiedRoutes } from '../lib/capabilities.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baseRelease = await fs.realpath('/opt/codex-mobile/current');
const baseUrl = 'http://127.0.0.1:20128/v1';
const configResponse = await fetch('http://127.0.0.1:5901/codex-api/rpc', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'config/read', params: {} }),
  signal: AbortSignal.timeout(8000) });
const configBody = await configResponse.json();
const config = configBody.result?.config;
const provider = config?.model_providers?.[config.model_provider];
if (config?.model_provider !== 'ninerouter' || provider?.base_url?.replace(/\/+$/, '') !== baseUrl) {
  throw new Error('Configured provider changed; refusing to probe a different route');
}
const requestHeaders = new Headers(provider.http_headers ?? {});
for (const [name, envName] of Object.entries(provider.env_http_headers ?? {})) {
  if (process.env[envName]) requestHeaders.set(name, process.env[envName]);
}
const bearer = provider.experimental_bearer_token || process.env[provider.env_key];
if (bearer && !requestHeaders.has('Authorization')) requestHeaders.set('Authorization', `Bearer ${bearer}`);
if (!requestHeaders.has('Authorization')) throw new Error('Existing provider authentication is unavailable; no inference sent');
requestHeaders.set('Content-Type', 'application/json');
const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error(`Gateway catalog HTTP ${response.status}`);
const advertised = await response.json();
const catalog = JSON.parse(await fs.readFile(path.join(baseRelease, 'ninerouter-models.json'), 'utf8'));
const candidates = ultraCandidates(advertised, catalog);
if (!candidates.length || candidates.length > 20) throw new Error(`Unexpected candidate count: ${candidates.length}; no inference sent`);
await fs.mkdir(path.join(repo, 'evidence'), { recursive: true });
const manifestPath = path.join(repo, 'evidence/ultra-capabilities.json');
try {
  await fs.access(manifestPath);
  if (process.argv.includes('--retry-after-unauthenticated')) {
    const previous = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (!previous.routes.length || previous.routes.some(route => route.httpStatus !== 401 || route.verified)) {
      throw new Error('Prior probes were not exclusively authentication failures; refusing to repeat inference');
    }
    const archive = path.join(repo, 'evidence/unauthenticated-preflight.json');
    try { await fs.access(archive); throw new Error('Authentication preflight archive already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(manifestPath, archive);
  } else throw new Error('Existing probe evidence found; refusing to repeat billable probes');
}
catch (error) { if (error.code !== 'ENOENT') throw error; }
const manifest = { schemaVersion: 1, providerId: 'ninerouter', baseUrl, codexVersion: '0.155.1',
  baseRelease, startedAt: new Date().toISOString(), requestLimits: { maxOutputTokens: 512, timeoutMs: 60000,
    requestsPerRoute: 1, tools: false, store: false }, routes: [] };
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ candidates: candidates.map(row => row.id), count: candidates.length }));
for (const candidate of candidates) {
  const started = Date.now();
  const result = { ...candidate, checkedAt: new Date().toISOString(), verified: false };
  try {
    const r = await fetch(`${baseUrl}/responses`, { method: 'POST', headers: requestHeaders,
      body: JSON.stringify({ model: candidate.id, input: 'Reply with exactly OK.', reasoning: { effort: 'ultra' },
        max_output_tokens: 512, tools: [], store: false, stream: false }), signal: AbortSignal.timeout(60000) });
    result.httpStatus = r.status;
    let body;
    try { body = await r.json(); } catch { result.failure = 'non-json-response'; }
    if (body) {
      result.responseStatus = body.status ?? null;
      result.returnedEffort = body.reasoning?.effort ?? null;
      result.resolvedModel = body.model ?? null;
      result.usage = body.usage ? { inputTokens: body.usage.input_tokens ?? null,
        outputTokens: body.usage.output_tokens ?? null,
        reasoningTokens: body.usage.output_tokens_details?.reasoning_tokens ?? null } : null;
      const output = (body.output ?? []).flatMap(item => item.content ?? [])
        .filter(content => content.type === 'output_text').map(content => content.text ?? '').join('');
      result.outputMatched = output.trim() === 'OK';
      result.verified = r.status === 200 && result.responseStatus === 'completed' &&
        result.returnedEffort === 'ultra' && result.outputMatched;
      if (!result.verified) {
        const code = body.error?.code ?? body.error?.type;
        result.failure = r.status !== 200 ? `http-${r.status}` : result.returnedEffort !== 'ultra'
          ? 'effort-not-confirmed' : result.responseStatus !== 'completed' ? 'response-not-completed' : 'unexpected-output';
        if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code)) result.errorCode = code;
      }
    }
  } catch (error) { result.failure = error.name === 'TimeoutError' ? 'timeout' : 'network-error'; }
  result.durationMs = Date.now() - started;
  result.reasoningOptions = [...new Set([...candidate.baselineEfforts, ...(result.verified ? ['ultra'] : [])])];
  manifest.routes.push(result);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ id: result.id, verified: result.verified, status: result.httpStatus,
    effort: result.returnedEffort, responseStatus: result.responseStatus, failure: result.failure, ms: result.durationMs }));
  if (result.httpStatus === 401 || result.httpStatus === 403) {
    manifest.stoppedForAuthentication = true;
    break;
  }
}
manifest.completedAt = new Date().toISOString();
manifest.verifiedCount = verifiedRoutes(manifest).length;
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ completed: true, verified: manifest.verifiedCount, total: manifest.routes.length, manifestPath }));
