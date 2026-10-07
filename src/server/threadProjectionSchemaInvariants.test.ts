import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { assertThreadProjectionIntegrity } from './threadProjectionIntegrity'
import { createCodexProjectionFixture } from './threadProjectionFixture'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

for (const legacy of [false, true]) {
  for (const [name, file, sql] of [
    ['state wrong key type', 'state_5.sqlite', 'DROP TABLE threads; CREATE TABLE threads(id INTEGER PRIMARY KEY, rollout_path TEXT NOT NULL)'],
    ['state missing primary key', 'state_5.sqlite', 'DROP TABLE threads; CREATE TABLE threads(id TEXT, rollout_path TEXT NOT NULL)'],
    ['state composite primary key', 'state_5.sqlite', 'DROP TABLE threads; CREATE TABLE threads(id TEXT, rollout_path TEXT NOT NULL, PRIMARY KEY(id,rollout_path))'],
    ['state nullable rollout path', 'state_5.sqlite', 'DROP TABLE threads; CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)'],
    ['state wrong rollout type', 'state_5.sqlite', 'DROP TABLE threads; CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path INTEGER NOT NULL)'],
    ['history wrong key type', 'thread_history_1.sqlite', 'DROP TABLE thread_history_projection_state; CREATE TABLE thread_history_projection_state(thread_id INTEGER PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL)'],
    ['history missing primary key', 'thread_history_1.sqlite', 'DROP TABLE thread_history_projection_state; CREATE TABLE thread_history_projection_state(thread_id TEXT, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL)'],
    ['history wrong offset type', 'thread_history_1.sqlite', 'DROP TABLE thread_history_projection_state; CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset TEXT NOT NULL, next_rollout_ordinal INTEGER NOT NULL)'],
    ['history nullable offset', 'thread_history_1.sqlite', 'DROP TABLE thread_history_projection_state; CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER NOT NULL)'],
    ['history missing ordinal', 'thread_history_1.sqlite', 'ALTER TABLE thread_history_projection_state DROP COLUMN next_rollout_ordinal'],
    ['history wrong ordinal type', 'thread_history_1.sqlite', 'DROP TABLE thread_history_projection_state; CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal TEXT NOT NULL)'],
    ['history nullable ordinal', 'thread_history_1.sqlite', 'DROP TABLE thread_history_projection_state; CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER)'],
  ]) {
    test(`rejects ${legacy ? 'legacy' : 'SQLx'} ${name} even without a checkpoint`, async () => {
      const home = createCodexProjectionFixture({legacy})
      try {
        const db = new DatabaseSync(join(home, file!)); try { db.exec(sql!) } finally { db.close() }
        await expect(assertThreadProjectionIntegrity(home, 'unprojected')).rejects.toThrow(/schema/)
      } finally { await rm(home, {recursive:true, force:true}) }
    })
  }
}
for (const file of ['state_5.sqlite','thread_history_1.sqlite']) {
  test(`rejects malformed SQLx ledger key in ${file}`, async () => {
    const home = createCodexProjectionFixture()
    try {
      const db = new DatabaseSync(join(home, file)); try {
        db.exec('ALTER TABLE _sqlx_migrations RENAME TO saved_migrations; CREATE TABLE _sqlx_migrations AS SELECT * FROM saved_migrations; DROP TABLE saved_migrations')
      } finally { db.close() }
      await expect(assertThreadProjectionIntegrity(home, 'unprojected')).rejects.toThrow(/schema/)
    } finally { await rm(home, {recursive:true, force:true}) }
  })
  test(`rejects nonzero user_version on lazy empty ${file}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'lazy-version-'))
    try {
      for (const name of ['state_5.sqlite','thread_history_1.sqlite']) {
        const db = new DatabaseSync(join(home,name)); try { if(name===file)db.exec('PRAGMA user_version=1') } finally { db.close() }
      }
      await expect(assertThreadProjectionIntegrity(home, 'unprojected')).rejects.toThrow(/schema/)
    } finally { await rm(home, {recursive:true, force:true}) }
  })
}
for (const offset of [Uint8Array.of(3), -1, 1.25, 9007199254740992, 'bad-offset']) {
  test(`rejects unsafe/non-integer checkpoint ${String(offset)}`, async () => {
    const home = createCodexProjectionFixture({offset})
    try { await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/integrity/) }
    finally { await rm(home,{recursive:true,force:true}) }
  })
}
test('retains damaged checkpoint rejection in reviewed newest schema without modifying state or rollout', async () => {
  const home = createCodexProjectionFixture({offset:99999})
  const digest = async () => Promise.all(['state_5.sqlite','thread_history_1.sqlite','fixture.jsonl'].map(async file => createHash('sha256').update(await readFile(join(home,file))).digest('hex')))
  try {
    const before = await digest()
    await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/history integrity mismatch/)
    expect(await digest()).toEqual(before)
  } finally { await rm(home,{recursive:true,force:true}) }
})
