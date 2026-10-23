import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BASELINE, sha256, replaceOnce, patchBackend, patchFrontend, patchCatalog } from '../lib/patch-release.mjs';
import { verifiedRoutes } from '../lib/capabilities.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = await fs.realpath('/opt/codex-mobile/current');
for (const [relative, expected] of Object.entries(BASELINE.files)) {
  if (sha256(await fs.readFile(path.join(base, relative))) !== expected) throw new Error(`Baseline drift: ${relative}; nothing deployed`);
}
const manifest = JSON.parse(await fs.readFile(path.join(repo, 'evidence/ultra-capabilities.json'), 'utf8'));
if (!manifest.completedAt) throw new Error('Gateway verification has not completed');
await fs.mkdir(path.join(repo, '.work'), { recursive: true });
const stage = await fs.mkdtemp(path.join(repo, '.work/release-'));
await fs.cp(base, stage, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
const changes = [];
const write = async (relative, content) => {
  const file = path.join(stage, relative);
  const before = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const body = Buffer.from(content);
  if (before?.equals(body)) return;
  await fs.writeFile(file, body);
  changes.push({ path: relative, before: before ? sha256(before) : null, after: sha256(body) });
};
const backend = patchBackend(await fs.readFile(path.join(base, 'app/dist-cli/index.js'), 'utf8'));
await write('app/dist-cli/index.js', backend);
for (const [from, to] of [['runtime.mjs', 'maintenance-runtime.mjs'], ['capabilities.mjs', 'maintenance-capabilities.mjs'],
  ['control-plane.mjs', 'maintenance-control-plane.mjs']]) {
  await write(`app/dist-cli/${to}`, await fs.readFile(path.join(repo, 'lib', from)));
}
await write('ultra-capabilities.json', `${JSON.stringify(manifest, null, 2)}\n`);
const frontend = patchFrontend(await fs.readFile(path.join(base, 'app/dist/assets/index-Be40V98R.js'), 'utf8'), manifest);
const asset = `index-ultra-${sha256(frontend).slice(0, 12)}.js`;
await write(`app/dist/assets/${asset}`, frontend);
await write('app/dist/index.html', replaceOnce(await fs.readFile(path.join(base, 'app/dist/index.html'), 'utf8'),
  '/assets/index-Be40V98R.js', `/assets/${asset}`));
await write('app/dist/sw.js', replaceOnce(await fs.readFile(path.join(base, 'app/dist/sw.js'), 'utf8'),
  "const CACHE_NAME = 'codexweb-shell-v2'", `const CACHE_NAME = 'codexweb-shell-ultra-${sha256(frontend).slice(0, 12)}'`));
const catalog = JSON.parse(await fs.readFile(path.join(base, 'ninerouter-models.json'), 'utf8'));
const patchedCatalog = patchCatalog(catalog, manifest);
if (JSON.stringify(catalog) !== JSON.stringify(patchedCatalog)) {
  await write('ninerouter-models.json', `${JSON.stringify(patchedCatalog, null, 2)}\n`);
}
execFileSync(path.join(base, 'runtime/bin/node'), ['--check', path.join(stage, 'app/dist-cli/index.js')]);
execFileSync(path.join(base, 'runtime/bin/node'), ['--check', path.join(stage, 'app/dist/assets', asset)]);
const proof = { schemaVersion: 1, createdAt: new Date().toISOString(), baseRelease: base,
  recordedSourceCommit: BASELINE.sourceCommit, baseline: BASELINE.files, asset,
  verifiedRoutes: verifiedRoutes(manifest).map(route => route.id),
  ultraStatus: verifiedRoutes(manifest).length ? 'verified-routes-enabled' : 'blocked-at-gateway',
  changes: changes.map(change => ({ ...change })), stateMigrated: false, credentialsModified: false, serviceSettingsModified: false };
await write('maintenance-proof.json', `${JSON.stringify(proof, null, 2)}\n`);
const checksums = [];
async function walk(relative = '') {
  for (const entry of (await fs.readdir(path.join(stage, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(next);
    else if (entry.isFile() && next !== 'SHA256SUMS') checksums.push(`${sha256(await fs.readFile(path.join(stage, next)))}  ${next}`);
  }
}
await walk();
await write('SHA256SUMS', `${checksums.join('\n')}\n`);
const result = { stage, base, asset, verifiedCount: proof.verifiedRoutes.length, changedFiles: changes.map(change => change.path),
  deployable: proof.verifiedRoutes.length > 0, reason: proof.verifiedRoutes.length ? null : 'No gateway route has verified non-downgraded ultra support' };
await fs.writeFile(path.join(repo, '.work/build-result.json'), `${JSON.stringify(result, null, 2)}\n`);
await fs.mkdir(path.join(repo, 'evidence'), { recursive: true });
await fs.writeFile(path.join(repo, 'evidence/build-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify(result));
