#!/opt/codex-mobile/current/runtime/bin/node
import fs from 'node:fs';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('codex 0.155.1');
  process.exit(0);
}

const config = { model: 'cx/gpt-6-astra', model_provider: 'ninerouter', approval_policy: 'never', sandbox_mode: 'danger-full-access',
  model_providers: { ninerouter: { name: 'Isolated fixture', base_url: 'http://127.0.0.1:20128/v1', wire_api: 'responses' } } };
function controls() { try { return JSON.parse(fs.readFileSync(process.env.MAINTENANCE_TEST_CONTROL, 'utf8')); } catch { return {}; } }
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  const state = controls();
  if (request.method === 'config/read' && state.stallConfig) return;
  if (request.method === 'model/list' && state.delayModels) {
    setTimeout(() => reply(request.id, { data: [], lateResponse: true }), state.delayModels);
    return;
  }
  if (request.method === 'initialize') return reply(request.id, { userAgent: 'isolated-fixture' });
  if (request.method === 'config/read') return reply(request.id, { config });
  if (request.method === 'model/list') {
    const catalog = JSON.parse(fs.readFileSync(process.env.CODEXUI_MODEL_CATALOG_JSON, 'utf8'));
    return reply(request.id, { data: catalog.models.map(model => ({ id: model.slug, model: model.slug,
      defaultReasoningEffort: model.default_reasoning_level,
      supportedReasoningEfforts: model.supported_reasoning_levels.map(level => ({ reasoningEffort: level.effort, description: level.description })) })), nextCursor: null });
  }
  if (request.method === 'thread/loaded/list') return reply(request.id, { data: [], nextCursor: null });
  if (request.method === 'account/read') return reply(request.id, { account: null, requiresOpenaiAuth: false });
  reply(request.id, {});
});
