import { test, expect } from 'vitest'
import { rm, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { assertThreadProjectionIntegrity } from './threadProjectionIntegrity'
import { createCodexProjectionFixture } from './threadProjectionFixture'
import { STATE_SQLX_MIGRATION_SHA384, HISTORY_SQLX_MIGRATION_SHA384 } from './threadProjectionMigrations'

test('accepts healthy state59/history8 with complete verified official migration checksums', async () => {
  const home = createCodexProjectionFixture()
  try { await expect(assertThreadProjectionIntegrity(home, 'fixture')).resolves.toBeUndefined() }
  finally { await rm(home, {recursive: true, force: true}) }
})

test('accepts state59 before history materialization without changing state or rollout', async () => {
  const home = createCodexProjectionFixture()
  const digest = async () => Promise.all(['state_5.sqlite', 'fixture.jsonl'].map(async file =>
    createHash('sha256').update(await readFile(join(home, file))).digest('hex')))
  try {
    await rm(join(home, 'thread_history_1.sqlite'))
    const before = await digest()
    await expect(assertThreadProjectionIntegrity(home, 'fixture')).resolves.toBeUndefined()
    await expect(assertThreadProjectionIntegrity(home, 'unprojected')).resolves.toBeUndefined()
    expect(await digest()).toEqual(before)
  } finally { await rm(home, {recursive: true, force: true}) }
})

test('applies the reviewed state59 attachment lookup index', async () => {
  const home = createCodexProjectionFixture()
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  try {
    const database = new DatabaseSync(join(home, 'state_5.sqlite'), {readOnly: true})
    try {
      expect(database.prepare('PRAGMA index_info(idx_thread_attachments_identity_thread)').all()
        .map((column: {name: string}) => column.name)).toEqual(['attachment_type', 'identity_key', 'thread_id'])
      expect(database.prepare('SELECT MAX(version) AS version FROM _sqlx_migrations').get().version).toBe(59)
    } finally { database.close() }
  } finally { await rm(home, {recursive: true, force: true}) }
})

test('applies the reviewed history8 nullable turn root without changing the projection contract', async () => {
  const home = createCodexProjectionFixture()
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  try {
    const database = new DatabaseSync(join(home, 'thread_history_1.sqlite'), {readOnly: true})
    try {
      expect(database.prepare('PRAGMA table_info(thread_turns)').all()
        .find((column: {name: string}) => column.name === 'root_turn_id'))
        .toMatchObject({type: 'TEXT', notnull: 0, pk: 0})
      expect(database.prepare('SELECT MAX(version) AS version FROM _sqlx_migrations').get().version).toBe(8)
    } finally { database.close() }
    await expect(assertThreadProjectionIntegrity(home, 'fixture')).resolves.toBeUndefined()
  } finally { await rm(home, {recursive: true, force: true}) }
})

for (const kind of ['state', 'history'] as const) {
  const reviewed = kind === 'state' ? STATE_SQLX_MIGRATION_SHA384 : HISTORY_SQLX_MIGRATION_SHA384
  for (let version = 1; version <= reviewed.length; version++) {
    test(`accepts complete reviewed ${kind} prefix ${version}`, async () => {
      const home = createCodexProjectionFixture(kind === 'state' ? {stateVersion: version} : {historyVersion: version})
      try { await expect(assertThreadProjectionIntegrity(home, 'fixture')).resolves.toBeUndefined() }
      finally { await rm(home, {recursive:true, force:true}) }
    })
  }
}

for (const legacy of [false, true]) {
  test(`accepts actual baseline54/6 ${legacy ? 'without ledger' : 'with verified ledger'}`, async () => {
    const home = createCodexProjectionFixture({stateVersion:54, historyVersion:6, legacy})
    try { await expect(assertThreadProjectionIntegrity(home, 'fixture')).resolves.toBeUndefined() }
    finally { await rm(home, {recursive:true, force:true}) }
  })
}

test('does not compare decoded checkpoints against compressed representation size', async () => {
  const home = createCodexProjectionFixture({offset:99999})
  const { DatabaseSync } = (await import('node:module')).createRequire(import.meta.url)('node:sqlite')
  const { join } = await import('node:path')
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    try { db.prepare('UPDATE threads SET rollout_path=?').run(join(home, 'fixture.jsonl.zst')) } finally { db.close() }
    await expect(assertThreadProjectionIntegrity(home, 'fixture')).resolves.toBeUndefined()
  } finally { await rm(home, {recursive:true,force:true}) }
})
