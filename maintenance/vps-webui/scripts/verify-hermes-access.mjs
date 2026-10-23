import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const node = '/opt/codex-mobile/current/runtime/bin/node';
const inheritedRoot = '/srv/robinhood/history/devbots/home/hermes';
assert.equal(process.getuid(), 0, 'Use sudo to create an independently owned inheritance fixture');
const inherited = path.join(inheritedRoot, `.codex-mobile-inheritance-check-${randomUUID()}`);
await fs.mkdir(inherited, { mode: 0o770 });
await fs.writeFile(path.join(inherited, 'root-owned.txt'), 'ACL inheritance verification only\n', { mode: 0o660, flag: 'wx' });
let result;
try {
  const serviceCode = String.raw`
    import fs from 'node:fs/promises';
    import { constants } from 'node:fs';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    assert.equal(process.getuid(), 999);
    const targets = ['/home/hermes'];
    for (const entry of await fs.readdir('/home/hermes', { withFileTypes: true })) {
      if (!entry.name.startsWith('.')) targets.push(path.join('/home/hermes', entry.name));
    }
    const checked = [];
    for (const target of targets) {
      assert.ok((await fs.stat(target)).isDirectory());
      await fs.access(target, constants.R_OK | constants.W_OK | constants.X_OK);
      await fs.readdir(target);
      const scratch = await fs.mkdtemp(path.join(target, '.codex-mobile-write-check-'));
      const child = path.join(scratch, 'child');
      const file = path.join(child, 'write.txt'), renamed = path.join(child, 'renamed.txt');
      try {
        await fs.mkdir(child);
        await fs.writeFile(file, 'temporary ACL check\n', { flag: 'wx' });
        await fs.appendFile(file, 'write verified\n');
        assert.match(await fs.readFile(file, 'utf8'), /write verified/);
        await fs.rename(file, renamed);
        await fs.unlink(renamed);
        await fs.rmdir(child);
      } finally {
        for (const name of [file, renamed]) await fs.unlink(name).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.rmdir(child).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.rmdir(scratch);
      }
      checked.push(target);
    }
    const inherited = process.argv[2];
    const rootOwned = path.join(inherited, 'root-owned.txt');
    assert.equal((await fs.stat(rootOwned)).uid, 0);
    await fs.access(rootOwned, constants.R_OK | constants.W_OK);
    await fs.appendFile(rootOwned, 'service-account write verified\n');
    await fs.mkdir(path.join(inherited, 'service-created-child'));
    await fs.rmdir(path.join(inherited, 'service-created-child'));
    const browserChecks = [];
    for (const target of ['/home/hermes', '/home/hermes/robinhood-research', '/home/hermes/Rust-MEV-Builder-consolidated-20260921']) {
      const response = await fetch('http://127.0.0.1:5901/codex-local-directories?path=' + encodeURIComponent(target), { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      assert.equal(response.status, 200, 'Live folder browser failed for ' + target);
      assert.ok(Array.isArray(data.data?.entries));
      browserChecks.push({ path: target, httpStatus: response.status, directoryCount: data.data.entries.length });
    }
    console.log(JSON.stringify({ uid: process.getuid(), checked, projectAndFolderWritesPassed: true,
      inheritedReadWriteFromDifferentOwnerPassed: true, liveBrowserChecks: browserChecks,
      applicationStateModified: false, realInferenceCalls: 0 }));
  `;
  const output = execFileSync('/usr/bin/setpriv', ['--reuid=999', '--regid=988', '--clear-groups',
    node, '--input-type=module', '-', inherited], { input: serviceCode, encoding: 'utf8', timeout: 30000 });
  result = { checkedAt: new Date().toISOString(), passed: true, ...JSON.parse(output.trim()) };
} finally {
  await fs.unlink(path.join(inherited, 'root-owned.txt'));
  await fs.rmdir(path.join(inherited, 'service-created-child')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await fs.rmdir(inherited);
}
const report = path.join(repo, 'evidence/hermes-access-verification.json');
await fs.writeFile(report, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
const owner = await fs.stat(repo);
await fs.chown(report, owner.uid, owner.gid); await fs.chmod(report, 0o644);
console.log(JSON.stringify(result));
