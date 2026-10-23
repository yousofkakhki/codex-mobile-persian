// Explicitly scoped OS ACL repair; never edits application artifacts or restarts services.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAcl, effectivePermission, accountPermission, grantAccount, renderAcl, normalizedEntries } from '../lib/filesystem-acl.mjs';

const exec = promisify(execFile);
const run = async (command, args) => {
  try { return (await exec(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })).stdout; }
  catch (error) { throw new Error(`${path.basename(command)} failed (${error.code}): ${(error.stderr ?? '').slice(0, 1200)}`); }
};
const uid = 999, groups = [988];
assert.equal(process.getuid(), 0, 'Use sudo for ACL snapshots and repair');
assert.equal((await run('/usr/bin/id', ['-u', 'codex-mobile'])).trim(), String(uid));
assert.deepEqual((await run('/usr/bin/id', ['-G', 'codex-mobile'])).trim().split(/\s+/).map(Number), groups, 'Service group membership drift');

const roots = ['/srv/robinhood/history/devbots/home/hermes', '/srv/robinhood/history/legacy-source',
  '/srv/robinhood/compat/robinhood-phase104-runv2-20261015', '/home/hermes/liquidation-v2-work',
  '/srv/robinhood/inputs/phase119'];
const ancestors = ['/srv/robinhood', '/srv/robinhood/history', '/srv/robinhood/history/devbots',
  '/srv/robinhood/history/devbots/home', '/srv/robinhood/compat', '/srv/robinhood/inputs'];
const top = '/home/hermes';
const excluded = ['/home/hermes/.config', '/home/hermes/.svm', '/home/hermes/.foundry'];
const contains = name => roots.some(root => name === root || name.startsWith(`${root}/`));
const hash = body => createHash('sha256').update(body).digest('hex');
const snapshot = async () => await run('/usr/bin/getfacl', ['-n', '-p', '--', top, ...ancestors]) +
  await run('/usr/bin/getfacl', ['-n', '-p', '-R', '-P', '--', ...roots]);
const excludedSnapshot = () => run('/usr/bin/getfacl', ['-n', '-p', '-R', '-P', '--', ...excluded]);
const service = () => run('/usr/bin/systemctl', ['show', 'codex-mobile.service',
  '--property=ActiveState,SubState,MainPID,NRestarts,User,Group,NoNewPrivileges']);
const save = (dir, name, value) => fs.writeFile(path.join(dir, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

async function scan() {
  const inventory = new Map(), symlinks = [];
  const add = async name => {
    const st = await fs.lstat(name);
    assert.ok(st.isDirectory() || st.isFile(), `Special paths or symlinks must not receive ACLs: ${name}`);
    inventory.set(name, { directory: st.isDirectory(), dev: st.dev, ino: st.ino, uid: st.uid, gid: st.gid, mode: st.mode });
  };
  for (const name of [top, ...ancestors]) await add(name);
  for (const root of roots) {
    assert.equal(await fs.realpath(root), root, `Root symlink drift: ${root}`);
    await add(root);
    const todo = [root];
    while (todo.length) {
      const dir = todo.pop();
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const name = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await fs.realpath(name);
          assert.ok(contains(target) || target === '/usr/bin/python3.13', `Unreviewed external symlink: ${name}`);
          symlinks.push({ path: name, target });
          continue;
        }
        await add(name);
        if (entry.isDirectory()) todo.push(name);
      }
    }
  }
  for (const entry of await fs.readdir(top, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const name = path.join(top, entry.name), target = await fs.realpath(name);
    assert.ok(contains(target), `Unreviewed project root: ${name}`);
  }
  return { inventory, symlinks };
}

function planned(records, inventory) {
  return records.map(record => {
    const st = inventory.get(record.path);
    assert.ok(st, `ACL snapshot contains an unreviewed path: ${record.path}`);
    const project = record.path === top || contains(record.path);
    const desired = !project ? 1 : st.directory ? 7 : 6 | ((st.mode & 0o111) ? 1 : 0);
    return grantAccount(record, { uid, groups, desired, directory: st.directory, inherit: project && st.directory });
  });
}

async function checkFileIdentities(inventory) {
  for (const [name, original] of inventory) {
    const current = await fs.lstat(name);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode']) assert.equal(current[key], original[key], `File metadata changed since planning: ${name}`);
  }
}

function compareActual(before, expected, actual) {
  const found = new Map(actual.map(record => [record.path, record]));
  for (let i = 0; i < expected.length; i++) {
    const original = before[i], wanted = expected[i], current = found.get(wanted.path);
    assert.ok(current, `Path missing after ACL repair: ${wanted.path}`);
    for (const key of ['uid', 'gid', 'flags']) assert.equal(current[key], original[key], `Ownership or special flags changed: ${wanted.path}`);
    assert.deepEqual(normalizedEntries(current.access), normalizedEntries(wanted.access), `Access ACL mismatch: ${wanted.path}`);
    assert.deepEqual(normalizedEntries(current.defaults), normalizedEntries(wanted.defaults), `Default ACL mismatch: ${wanted.path}`);
    for (const [kind, entries] of [['access', original.access], ['defaults', original.defaults]]) {
      for (const [key] of entries) {
        if (key === 'mask:' || key === `user:${uid}` || (key === 'user:' && kind === 'access' && original.uid === uid)) continue;
        assert.equal(effectivePermission(current[kind], key), effectivePermission(entries, key), `Other user's effective permissions changed: ${wanted.path}`);
      }
    }
    assert.ok(accountPermission(current, uid, groups) & 1 || !current.defaults.size, `Directory is not traversable: ${wanted.path}`);
  }
}

const [mode, requestedDir] = process.argv.slice(2);
if (mode === '--plan') {
  const dir = await fs.mkdtemp('/var/backups/codex-mobile-hermes-acl-');
  await fs.chmod(dir, 0o700);
  console.log(JSON.stringify({ phase: 'inventory', backupDirectory: dir }));
  const { inventory, symlinks } = await scan();
  const before = await snapshot();
  const records = parseAcl(before);
  assert.equal(records.length, inventory.size, 'Every reviewed file must have an ACL backup');
  const expected = planned(records, inventory);
  const plan = renderAcl(expected);
  await save(dir, 'before.acl', before);
  await save(dir, 'planned.acl', plan);
  await save(dir, 'excluded-before.acl', await excludedSnapshot());
  const metadata = { createdAt: new Date().toISOString(), roots, ancestors, top, excluded,
    inventory: [...inventory], symlinks, beforeSha256: hash(before), planSha256: hash(plan), serviceBefore: await service(),
    files: [...inventory.values()].filter(st => !st.directory).length, directories: [...inventory.values()].filter(st => st.directory).length };
  await save(dir, 'plan.json', metadata);
  await run('/usr/bin/setfacl', ['--test', `--restore=${path.join(dir, 'planned.acl')}`]);
  console.log(JSON.stringify({ phase: 'planned', backupDirectory: dir, files: metadata.files, directories: metadata.directories,
    symlinksNotModified: symlinks.length, dryRunPassed: true, serviceChanged: false }));
} else if (mode === '--apply') {
  const dir = await fs.realpath(requestedDir);
  assert.equal(path.dirname(dir), '/var/backups');
  assert.ok(path.basename(dir).startsWith('codex-mobile-hermes-acl-'));
  const dirInfo = await fs.stat(dir);
  assert.equal(dirInfo.uid, 0); assert.equal(dirInfo.mode & 0o777, 0o700);
  const metadata = JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8'));
  assert.deepEqual(metadata.roots, roots); assert.deepEqual(metadata.ancestors, ancestors); assert.equal(metadata.top, top);
  const beforeText = await fs.readFile(path.join(dir, 'before.acl'), 'utf8');
  const planText = await fs.readFile(path.join(dir, 'planned.acl'), 'utf8');
  assert.equal(hash(beforeText), metadata.beforeSha256); assert.equal(hash(planText), metadata.planSha256);
  assert.equal(hash(await snapshot()), metadata.beforeSha256, 'ACLs changed since planning; prepare a new snapshot');
  const inventory = new Map(metadata.inventory);
  await checkFileIdentities(inventory);
  const expected = planned(parseAcl(beforeText), inventory);
  assert.equal(renderAcl(expected), planText, 'Stored plan differs from the reviewed scope');
  console.log(JSON.stringify({ phase: 'applying', files: metadata.files, directories: metadata.directories, backupDirectory: dir }));
  await run('/usr/bin/setfacl', [`--restore=${path.join(dir, 'planned.acl')}`]);
  const afterText = await snapshot();
  await save(dir, 'after.acl', afterText);
  compareActual(parseAcl(beforeText), expected, parseAcl(afterText));
  assert.equal(await excludedSnapshot(), await fs.readFile(path.join(dir, 'excluded-before.acl'), 'utf8'), 'Excluded configuration/toolchain ACLs changed');
  const serviceAfter = await service();
  assert.equal(serviceAfter, metadata.serviceBefore, 'Service identity/status changed during ACL repair');
  const report = { appliedAt: new Date().toISOString(), verified: true, files: metadata.files, directories: metadata.directories,
    symlinksNotModified: metadata.symlinks.length, ownershipPreserved: true, otherEffectivePermissionsPreserved: true,
    hiddenConfigurationAndToolchainsUnchanged: true, serviceChanged: false, beforeSha256: metadata.beforeSha256,
    afterSha256: hash(afterText), backupDirectory: dir, rollback: `sudo -n /usr/bin/setfacl --restore=${path.join(dir, 'before.acl')}` };
  await save(dir, 'result.json', report);
  console.log(JSON.stringify(report));
} else throw new Error('Usage: sudo node scripts/home-hermes-access.mjs --plan | --apply /var/backups/codex-mobile-hermes-acl-XXXXXX');
