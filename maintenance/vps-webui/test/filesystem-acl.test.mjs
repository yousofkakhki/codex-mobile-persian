import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAcl, permissionBits, permissionText, effectivePermission, accountPermission, grantAccount, renderAcl } from '../lib/filesystem-acl.mjs';

const parse = extra => parseAcl(`# file: /example/project\n# owner: 1000\n# group: 1003\nuser::rwx\n${extra}\nother::r-x\n\n`)[0];
const options = { uid: 999, groups: [988], desired: 7, directory: true, inherit: true };

test('ACL permission strings round trip', () => {
  for (let value = 0; value < 8; value++) assert.equal(permissionBits(permissionText(value)), value);
});
test('new account gets directory access and default inheritance', () => {
  const original = parse('group::r-x');
  const updated = grantAccount(original, options);
  assert.equal(accountPermission(updated, 999, [988]), 7);
  assert.equal(effectivePermission(updated.defaults, 'user:999'), 7);
  assert.equal(effectivePermission(updated.access, 'group:'), 5);
  assert.equal(updated.access.get('other:'), 5);
});
test('expanding an existing mask preserves all other effective grants', () => {
  const original = parse('user:1004:rwx\ngroup::rwx\ngroup:1005:rwx\nmask::r--');
  const updated = grantAccount(original, options);
  for (const key of ['user:', 'user:1004', 'group:', 'group:1005', 'other:']) {
    assert.equal(effectivePermission(updated.access, key), effectivePermission(original.access, key), key);
  }
  assert.equal(accountPermission(updated, 999, [988]), 7);
});
test('existing default ACL restrictions remain effective after inheritance grant', () => {
  const original = parse('group::r-x\ndefault:user::rwx\ndefault:user:1004:rwx\ndefault:group::rwx\ndefault:mask::r--\ndefault:other::---');
  const updated = grantAccount(original, options);
  assert.equal(effectivePermission(updated.defaults, 'user:1004'), 4);
  assert.equal(effectivePermission(updated.defaults, 'group:'), 4);
  assert.equal(effectivePermission(updated.defaults, 'user:999'), 7);
});
test('ancestors retain existing readable access without adding write or defaults', () => {
  const updated = grantAccount(parse('group::r-x'), { ...options, desired: 1, inherit: false });
  assert.equal(accountPermission(updated, 999, [988]), 5);
  assert.equal(updated.defaults.size, 0);
});
test('regular files gain read/write without becoming executable', () => {
  const original = parseAcl('# file: /example/file\n# owner: 1000\n# group: 1003\nuser::rw-\ngroup::r--\nother::r--\n')[0];
  const updated = grantAccount(original, { ...options, desired: 6, directory: false, inherit: false });
  assert.equal(accountPermission(updated, 999, [988]), 6);
  assert.equal(updated.defaults.size, 0);
});
test('account-owned paths update owner permissions because named user entries do not override the owner', () => {
  const original = { ...parse('group::---'), uid: 999 };
  original.access.set('user:', 4);
  const updated = grantAccount(original, options);
  assert.equal(accountPermission(updated, 999, [988]), 7);
});
test('explicit named-user permission takes precedence over supplementary groups', () => {
  const original = parse('user:999:--x\ngroup::rwx\nmask::rwx');
  assert.equal(accountPermission(original, 999, [1003]), 1);
});
test('generated restore input keeps special flags and intentionally omits ownership changes', () => {
  const updated = grantAccount({ ...parse('group::r-x'), flags: '-s-' }, options);
  const output = renderAcl([updated]);
  assert.ok(output.includes('# flags: -s-'));
  assert.ok(!output.includes('# owner:'));
  assert.ok(!output.includes('# group:'));
  const parsed = parseAcl(output)[0];
  assert.equal(parsed.access.get('user:999'), 7);
});
