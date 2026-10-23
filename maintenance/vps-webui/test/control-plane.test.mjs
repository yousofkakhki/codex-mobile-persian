import test from 'node:test';
import assert from 'node:assert/strict';
import { callAppServer, runControlRpc, createProviderDiscovery, discoveryHttpStatus } from '../lib/control-plane.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function server(sendLine = () => {}) { return { start() {}, nextId: 1, pending: new Map(), sendLine }; }
const good = { providerId: 'ninerouter', source: 'provider', data: ['cx/test'], models: [{ id: 'cx/test', reasoningOptions: ['low'] }] };
const options = { timeoutMs: 15, getKey: () => 'same', warn: () => {}, retryMs: 0, ttlMs: 0 };

test('read-only RPC timeout removes pending entry', async () => {
  const fake = server();
  await assert.rejects(runControlRpc('config/read', signal => callAppServer(fake, 'config/read', {}, { signal }), { timeoutMs: 10 }), { name: 'TimeoutError', code: -32008 });
  assert.equal(fake.pending.size, 0);
});
test('model/list also has a bounded deadline', async () => {
  const fake = server();
  await assert.rejects(runControlRpc('model/list', signal => callAppServer(fake, 'model/list', {}, { signal }), { timeoutMs: 10 }));
  assert.equal(fake.pending.size, 0);
});
test('late RPC response after cancellation cannot resolve a different request', async () => {
  const fake = server(); let late;
  fake.sendLine = message => { late = fake.pending.get(message.id); };
  await assert.rejects(runControlRpc('config/read', signal => callAppServer(fake, 'config/read', {}, { signal }), { timeoutMs: 5 }));
  late.resolve({ shouldBeIgnored: true });
  assert.equal(fake.pending.size, 0);
});
test('normal RPC response resolves and cleans pending state', async () => {
  const fake = server(); fake.sendLine = message => queueMicrotask(() => fake.pending.get(message.id).resolve({ ok: true }));
  assert.deepEqual(await runControlRpc('model/list', signal => callAppServer(fake, 'model/list', {}, { signal })), { ok: true });
  assert.equal(fake.pending.size, 0);
});
test('write failure rejects without leaking pending state', async () => {
  const fake = server(() => { throw new Error('pipe closed'); });
  await assert.rejects(callAppServer(fake, 'config/read', {}), /pipe closed/);
  assert.equal(fake.pending.size, 0);
});
test('already cancelled reads do not start app-server', async () => {
  const fake = server(); fake.start = () => assert.fail('must not start');
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(callAppServer(fake, 'config/read', {}, { signal: controller.signal }), /cancelled/);
});
test('long-running turn/start is not assigned a control timeout', async () => {
  const result = await runControlRpc('turn/start', async () => { await delay(20); return 'ok'; }, { timeoutMs: 1 });
  assert.equal(result, 'ok');
});
test('timeout before initialization cannot send a later read', async () => {
  const fake = server(() => assert.fail('must not send'));
  await assert.rejects(runControlRpc('config/read', async signal => { await delay(20); return callAppServer(fake, 'config/read', {}, { signal }); }, { timeoutMs: 5 }));
  await delay(25); assert.equal(fake.pending.size, 0);
});
test('cold discovery stall returns a clear 503 body', async () => {
  const discovery = createProviderDiscovery(options);
  const result = await discovery.read({}, () => new Promise(() => {}));
  assert.equal(discoveryHttpStatus(result), 503); assert.equal(result.code, 'PROVIDER_MODELS_UNAVAILABLE');
});
test('warm discovery failure retains last successful metadata', async () => {
  const discovery = createProviderDiscovery(options); const fake = {};
  assert.equal((await discovery.read(fake, () => good)).stale, false);
  const stale = await discovery.read(fake, () => { throw new Error('upstream 502'); });
  assert.equal(stale.stale, true); assert.deepEqual(stale.models, good.models); assert.equal(discoveryHttpStatus(stale), 200);
});
test('configuration changes invalidate warm fallback', async () => {
  let key = 'first'; const discovery = createProviderDiscovery({ ...options, getKey: () => key }); const fake = {};
  await discovery.read(fake, () => good); key = 'second';
  const result = await discovery.read(fake, () => { throw new Error('timeout'); });
  assert.equal(discoveryHttpStatus(result), 503); assert.deepEqual(result.data, []);
});
test('concurrent discovery calls share one refresh', async () => {
  let calls = 0; const discovery = createProviderDiscovery({ ...options, timeoutMs: 100 }); const fake = {};
  const load = async () => { calls++; await delay(5); return good; };
  const results = await Promise.all([discovery.read(fake, load), discovery.read(fake, load), discovery.read(fake, load)]);
  assert.equal(calls, 1); assert.ok(results.every(result => result.models.length === 1));
});
test('HTML/invalid discovery fallback does not replace valid metadata', async () => {
  const discovery = createProviderDiscovery(options); const fake = {};
  await discovery.read(fake, () => good);
  const stale = await discovery.read(fake, () => ({ providerId: 'ninerouter', data: ['configured-only'] }));
  assert.equal(stale.stale, true); assert.deepEqual(stale.data, good.data);
});
test('changed configuration during refresh never returns old-provider data', async () => {
  let key = 'old'; const discovery = createProviderDiscovery({ ...options, getKey: () => key }); const fake = {};
  const result = await discovery.read(fake, () => { key = 'new'; return good; });
  assert.equal(discoveryHttpStatus(result), 503);
});
test('cold-start transition to initialized does not invalidate unchanged configuration', async () => {
  const fake = { activeConfigSignature: '', buildAppServerConfig: () => ({ args: ['same'], env: {} }),
    getAppServerConfigSignature: config => JSON.stringify(config) };
  const discovery = createProviderDiscovery({ timeoutMs: 100, warn: () => {} });
  const result = await discovery.read(fake, () => { fake.activeConfigSignature = 'initialized'; return good; });
  assert.equal(discoveryHttpStatus(result), 200); assert.equal(result.stale, false);
});
