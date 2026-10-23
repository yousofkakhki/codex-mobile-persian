import assert from 'node:assert/strict';

export const permissionBits = text => {
  assert.match(text, /^[r-][w-][x-]$/);
  return (text[0] === 'r' ? 4 : 0) | (text[1] === 'w' ? 2 : 0) | (text[2] === 'x' ? 1 : 0);
};
export const permissionText = bits => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;

export function parseAcl(text) {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map(block => {
    const lines = block.split('\n');
    const header = key => lines.find(line => line.startsWith(`# ${key}: `))?.slice(key.length + 4);
    const encodedPath = header('file');
    assert.ok(encodedPath?.startsWith('/'), 'ACL paths must be absolute');
    const name = encodedPath.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const access = new Map(), defaults = new Map();
    for (const line of lines.filter(line => line && !line.startsWith('#'))) {
      const match = /^(default:)?(user|group|mask|other):([0-9]*):([r-][w-][x-])(?:\s+#.*)?$/.exec(line);
      assert.ok(match, `Unknown ACL syntax for ${name}`);
      (match[1] ? defaults : access).set(`${match[2]}:${match[3]}`, permissionBits(match[4]));
    }
    for (const key of ['user:', 'group:', 'other:']) assert.ok(access.has(key), `Missing base ACL: ${name}`);
    return { path: name, encodedPath, uid: Number(header('owner')), gid: Number(header('group')),
      flags: header('flags') ?? '---', access, defaults };
  });
}

export function effectivePermission(entries, key) {
  const value = entries.get(key) ?? 0;
  return key === 'user:' || key === 'other:' ? value : value & (entries.get('mask:') ?? 7);
}

export function accountPermission(record, uid, groups) {
  if (record.uid === uid) return record.access.get('user:');
  if (record.access.has(`user:${uid}`)) return effectivePermission(record.access, `user:${uid}`);
  let matches = false, bits = 0;
  for (const [key] of record.access) {
    if (!key.startsWith('group:')) continue;
    const gid = key === 'group:' ? record.gid : Number(key.slice(6));
    if (groups.includes(gid)) { matches = true; bits |= effectivePermission(record.access, key); }
  }
  return matches ? bits : record.access.get('other:');
}

function grant(entries, uid, wanted) {
  const result = new Map(entries);
  // Expanding the mask must not unmask old grants to other users or groups.
  for (const [key] of result) {
    if ((key.startsWith('user:') && key !== 'user:') || key.startsWith('group:')) {
      result.set(key, effectivePermission(entries, key));
    }
  }
  result.set(`user:${uid}`, wanted | effectivePermission(entries, `user:${uid}`));
  result.set('mask:', (entries.get('mask:') ?? entries.get('group:')) | wanted);
  return result;
}

export function grantAccount(record, { uid, groups, desired, directory, inherit }) {
  const wanted = desired | accountPermission(record, uid, groups);
  const access = grant(record.access, uid, wanted);
  if (record.uid === uid) access.set('user:', access.get('user:') | wanted);
  const defaults = directory && inherit ? grant(record.defaults.size ? record.defaults : record.access, uid, 7) : new Map(record.defaults);
  return { ...record, access, defaults };
}

export function renderAcl(records) {
  return records.map(record => {
    const lines = [`# file: ${record.encodedPath}`, `# flags: ${record.flags}`];
    for (const [prefix, entries] of [['', record.access], ['default:', record.defaults]]) {
      const rank = key => key === 'user:' ? 0 : key.startsWith('user:') ? 1 : key === 'group:' ? 2 : key.startsWith('group:') ? 3 : key === 'mask:' ? 4 : 5;
      for (const [key, bits] of [...entries].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))) {
        lines.push(`${prefix}${key}:${permissionText(bits)}`);
      }
    }
    return lines.join('\n');
  }).join('\n\n') + '\n\n';
}

export const normalizedEntries = entries => [...entries].sort(([a], [b]) => a.localeCompare(b));
