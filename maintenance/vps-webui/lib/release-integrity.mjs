import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BASELINE, sha256 } from './patch-release.mjs';
import { verifiedRoutes } from './capabilities.mjs';

export async function inventory(root) {
  const entries = new Map();
  async function walk(relative = '') {
    const children = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      const file = path.join(root, name);
      const info = await fs.lstat(file);
      const value = { mode: info.mode & 0o777 };
      if (entry.isDirectory()) {
        entries.set(name, { ...value, type: 'directory' });
        await walk(name);
      } else if (entry.isSymbolicLink()) entries.set(name, { ...value, type: 'symlink', target: await fs.readlink(file) });
      else if (entry.isFile()) entries.set(name, { ...value, type: 'file', sha256: sha256(await fs.readFile(file)) });
      else throw new Error(`Unexpected release entry type: ${name}`);
    }
  }
  await walk();
  return entries;
}

export function compareInventories(before, after, changes, generated = []) {
  const declared = new Map(changes.map(change => [change.path, change]));
  assert.equal(declared.size, changes.length, 'Duplicate declared changes');
  const allowed = new Set([...declared.keys(), ...generated]);
  for (const [name, original] of before) {
    if (!allowed.has(name)) assert.deepEqual(after.get(name), original, `Unrelated release entry changed or missing: ${name}`);
  }
  for (const name of after.keys()) assert.ok(before.has(name) || allowed.has(name), `Undeclared new release entry: ${name}`);
  for (const [name, change] of declared) {
    const original = before.get(name), updated = after.get(name);
    assert.ok(!original || original.type === 'file', `Original is not a regular file: ${name}`);
    assert.equal(updated?.type, 'file', `Updated path is not a regular file: ${name}`);
    assert.equal(original?.sha256 ?? null, change.before, `Incorrect original hash: ${name}`);
    assert.equal(updated.sha256, change.after, `Incorrect updated hash: ${name}`);
    if (original) assert.equal(updated.mode, original.mode, `Unexpected permission change: ${name}`);
  }
}

export async function verifyRelease(build) {
  const base = await fs.realpath(build.base), stage = await fs.realpath(build.stage);
  assert.notEqual(base, stage, 'Candidate cannot be the live release');
  const proof = JSON.parse(await fs.readFile(path.join(stage, 'maintenance-proof.json'), 'utf8'));
  assert.equal(proof.baseRelease, base);
  assert.equal(proof.recordedSourceCommit, BASELINE.sourceCommit);
  assert.deepEqual(proof.baseline, BASELINE.files);
  const [before, after] = await Promise.all([inventory(base), inventory(stage)]);
  for (const [file, expected] of Object.entries(BASELINE.files)) assert.equal(before.get(file)?.sha256, expected, `Baseline drift: ${file}`);
  assert.match(build.asset, /^index-ultra-[a-f0-9]{12}\.js$/);
  assert.equal(proof.asset, build.asset);
  const allowed = new Set(['app/dist-cli/index.js', 'app/dist-cli/maintenance-runtime.mjs',
    'app/dist-cli/maintenance-capabilities.mjs', 'app/dist-cli/maintenance-control-plane.mjs',
    'ultra-capabilities.json', `app/dist/assets/${build.asset}`, 'app/dist/index.html',
    'app/dist/sw.js', 'ninerouter-models.json']);
  for (const change of proof.changes) assert.ok(allowed.has(change.path), `Out-of-scope overlay: ${change.path}`);
  compareInventories(before, after, proof.changes, ['maintenance-proof.json', 'SHA256SUMS']);
  const checksums = new Map();
  for (const line of (await fs.readFile(path.join(stage, 'SHA256SUMS'), 'utf8')).trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, 'Malformed checksum entry');
    assert.ok(!checksums.has(match[2]), `Duplicate checksum: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  const files = [...after].filter(([name, value]) => value.type === 'file' && name !== 'SHA256SUMS');
  assert.equal(checksums.size, files.length, 'Checksum manifest must cover every release file');
  for (const [name, value] of files) assert.equal(checksums.get(name), value.sha256, `Checksum mismatch: ${name}`);
  const manifest = JSON.parse(await fs.readFile(path.join(stage, 'ultra-capabilities.json'), 'utf8'));
  const verified = verifiedRoutes(manifest).map(route => route.id);
  assert.deepEqual(proof.verifiedRoutes, verified);
  assert.equal(build.verifiedCount, verified.length);
  if (!verified.length) assert.equal(build.deployable, false, 'Unverified ultra must block rollout');
  return { checkedAt: new Date().toISOString(), base, stage, passed: true,
    entriesCompared: before.size, checksumsVerified: files.length,
    changedFiles: proof.changes.map(change => change.path),
    originalAssetPreserved: before.get('app/dist/assets/index-Be40V98R.js')?.sha256 === after.get('app/dist/assets/index-Be40V98R.js')?.sha256,
    runtimeCatalogUnchanged: before.get('ninerouter-models.json')?.sha256 === after.get('ninerouter-models.json')?.sha256,
    verifiedCount: verified.length, checksumManifestSha256: after.get('SHA256SUMS').sha256 };
}
