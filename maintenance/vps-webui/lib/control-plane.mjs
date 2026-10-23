import { createHash } from 'node:crypto';
import { statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const CONTROL_TIMEOUT_MS = 8000;
const CONTROL_METHODS = new Set(['config/read', 'model/list']);

function timeoutError(kind, timeoutMs, method) {
  const error = new Error(`${method ?? 'Provider model discovery'} timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.code = -32008;
  error.kind = kind;
  return error;
}

export function withDeadline(operation, timeoutMs, { signal: parent, kind = 'READ_ONLY_RPC_TIMEOUT', method } = {}) {
  const controller = new AbortController();
  let timer;
  let onParent;
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    onParent = () => controller.abort(parent.reason ?? new Error('Request cancelled'));
    if (parent?.aborted) onParent();
    else parent?.addEventListener('abort', onParent, { once: true });
    timer = setTimeout(() => controller.abort(timeoutError(kind, timeoutMs, method)), timeoutMs);
  });
  const work = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw controller.signal.reason;
    return operation(controller.signal);
  });
  return Promise.race([work, aborted]).finally(() => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  });
}

export function runControlRpc(method, operation, { signal, timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
  if (!CONTROL_METHODS.has(method)) return operation(signal);
  return withDeadline(operation, timeoutMs, { signal, method });
}

export async function callAppServer(server, method, params, { signal } = {}) {
  if (signal?.aborted) throw signal.reason;
  server.start();
  const id = server.nextId++;
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (server.pending.get(id) === pending) server.pending.delete(id);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new Error('Request cancelled'));
    pending = { resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
    server.pending.set(id, pending);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try { server.sendLine({ jsonrpc: '2.0', id, method, params }); }
    catch (error) { finish(reject, error); }
  });
}

function fileIdentity(file) {
  try {
    const info = statSync(file, { bigint: true });
    return [file, String(info.ino), String(info.mtimeNs), String(info.size)];
  } catch (error) { return [file, error.code ?? 'unavailable']; }
}

export function discoveryConfigurationKey(server) {
  const runtime = typeof server.buildAppServerConfig === 'function' && typeof server.getAppServerConfigSignature === 'function'
    ? server.getAppServerConfigSignature(server.buildAppServerConfig()) : server.activeConfigSignature ?? '';
  const home = process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
  const files = [path.join(home, 'config.toml')];
  try {
    for (const name of readdirSync(home)) {
      if (name.includes('free-mode') && name.endsWith('.json')) files.push(path.join(home, name));
    }
  } catch { /* A cold or inaccessible configuration cannot reuse another key. */ }
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    files.push(path.join(dir, '.codex/config.toml'));
    if (path.dirname(dir) === dir) break;
  }
  if (process.env.CODEXUI_MODEL_CATALOG_JSON) files.push(process.env.CODEXUI_MODEL_CATALOG_JSON);
  return createHash('sha256').update(JSON.stringify({
    files: files.map(fileIdentity), runtime,
  })).digest('hex');
}

function unavailable() {
  return { data: [], models: [], providerId: '', source: 'provider', stale: false,
    code: 'PROVIDER_MODELS_UNAVAILABLE', error: 'Model discovery is temporarily unavailable. Please retry shortly.' };
}

export function createProviderDiscovery({ timeoutMs = CONTROL_TIMEOUT_MS, ttlMs = 30000, retryMs = 5000,
  getKey = discoveryConfigurationKey, now = Date.now, warn = console.warn } = {}) {
  const states = new WeakMap();
  return {
    async read(server, discover) {
      const key = getKey(server);
      let state = states.get(server);
      if (state?.key !== key) {
        state = { key, value: null, fetchedAt: 0, nextRetryAt: 0, pending: null, failed: false };
        states.set(server, state);
      }
      const fallback = () => {
        if (getKey(server) !== key || states.get(server) !== state) return unavailable();
        return state.value ? { ...state.value, stale: true,
          discoveryWarning: 'Model discovery is unavailable; showing the last successful catalog.' } : unavailable();
      };
      if (state.value && !state.failed && now() - state.fetchedAt < ttlMs) return { ...state.value, stale: false };
      if (now() < state.nextRetryAt) return fallback();
      if (state.pending) return state.pending;
      const started = now();
      state.pending = withDeadline(discover, timeoutMs, { kind: 'PROVIDER_DISCOVERY_TIMEOUT' }).then(value => {
        if (getKey(server) !== key || states.get(server) !== state) return unavailable();
        if (value.providerId && value.providerId !== 'ninerouter' && !value.models) return value;
        if (!Array.isArray(value.data) || !Array.isArray(value.models) || !value.models.length) {
          const error = new Error('Discovery did not return model metadata');
          error.kind = 'PROVIDER_DISCOVERY_INCOMPLETE';
          throw error;
        }
        state.value = { ...value, stale: false };
        state.fetchedAt = now();
        state.failed = false;
        state.nextRetryAt = 0;
        return state.value;
      }).catch(error => {
        state.failed = true;
        state.nextRetryAt = now() + retryMs;
        warn('[codex-provider-models]', 'model discovery unavailable', {
          code: error.kind ?? 'PROVIDER_DISCOVERY_FAILED', durationMs: now() - started,
        });
        return fallback();
      }).finally(() => { state.pending = null; });
      return state.pending;
    },
  };
}

export function discoveryHttpStatus(body, status = 200) {
  return body?.code === 'PROVIDER_MODELS_UNAVAILABLE' ? 503 : status;
}
