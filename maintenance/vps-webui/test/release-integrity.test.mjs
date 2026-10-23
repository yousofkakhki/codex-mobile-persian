import test from 'node:test';
import assert from 'node:assert/strict';
import { compareInventories } from '../lib/release-integrity.mjs';

const original = { type: 'file', mode: 0o755, sha256: 'original' };
const updated = { ...original, sha256: 'updated' };
const change = { path: 'cli.js', before: 'original', after: 'updated' };
const before = () => new Map([['cli.js', original], ['original-asset.js', original]]);
const after = () => new Map([['cli.js', updated], ['original-asset.js', original]]);

test('release comparison accepts declared edits while preserving original assets', () => {
  assert.doesNotThrow(() => compareInventories(before(), after(), [change]));
});
test('unrelated modifications or missing files fail verification', () => {
  const modified = after(); modified.set('original-asset.js', updated);
  assert.throws(() => compareInventories(before(), modified, [change]), /Unrelated/);
  modified.delete('original-asset.js');
  assert.throws(() => compareInventories(before(), modified, [change]), /Unrelated/);
});
test('undeclared new files fail verification', () => {
  const modified = after(); modified.set('unexpected.js', original);
  assert.throws(() => compareInventories(before(), modified, [change]), /Undeclared/);
});
test('incorrect hashes and duplicate declarations fail verification', () => {
  assert.throws(() => compareInventories(before(), after(), [{ ...change, after: 'wrong' }]), /Incorrect updated hash/);
  assert.throws(() => compareInventories(before(), after(), [change, change]), /Duplicate/);
});
test('permission changes and symlink substitution fail verification', () => {
  const modified = after(); modified.set('cli.js', { ...updated, mode: 0o777 });
  assert.throws(() => compareInventories(before(), modified, [change]), /permission/);
  modified.set('cli.js', { type: 'symlink', mode: 0o777, target: '/elsewhere' });
  assert.throws(() => compareInventories(before(), modified, [change]), /not a regular file/);
});
