import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertThreadProjectionIntegrity } from './threadProjectionIntegrity'
import { createCodexProjectionFixture } from './threadProjectionFixture'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

for (const kind of ['state', 'history'] as const) {
  const file = kind === 'state' ? 'state_5.sqlite' : 'thread_history_1.sqlite'
  const max = kind === 'state' ? 58 : 7
  for (const [reason, sql] of [
    ['changed checksum', 'UPDATE _sqlx_migrations SET checksum=zeroblob(48) WHERE version=1'],
    ['missing first migration', 'DELETE FROM _sqlx_migrations WHERE version=1'],
    ['missing interior migration', 'DELETE FROM _sqlx_migrations WHERE version=3'],
    ['failed migration', 'UPDATE _sqlx_migrations SET success=0 WHERE version=1'],
    ['future migration', `INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(${max+1},'unknown',1,zeroblob(48),0)`],
    ['empty migration ledger', 'DELETE FROM _sqlx_migrations'],
    ['unknown version zero', "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(0,'unknown',1,zeroblob(48),0)"],
    ['non-blob checksum', "UPDATE _sqlx_migrations SET checksum=CAST(checksum AS TEXT) WHERE version=1"],
  ]) {
    test(`rejects ${kind} ${reason} without requiring a checkpoint for this ID`, async () => {
      const home = createCodexProjectionFixture()
      try {
        const db = new DatabaseSync(join(home, file)); try { db.exec(sql!) } finally { db.close() }
        await expect(assertThreadProjectionIntegrity(home, 'unprojected')).rejects.toThrow(/schema/)
      } finally { await rm(home, {recursive:true, force:true}) }
    })
  }
  for (const ledgerName of ['_SQLX_MIGRATIONS', '_Sqlx_Migrations']) {
    test(`accepts ${kind} audited complete ledger named ${ledgerName}`, async () => {
      const home = createCodexProjectionFixture()
      try {
        const db = new DatabaseSync(join(home, file))
        try {
          db.exec(`ALTER TABLE _sqlx_migrations RENAME TO migration_ledger_source; ALTER TABLE migration_ledger_source RENAME TO ${ledgerName}`)
        } finally { db.close() }
        await expect(assertThreadProjectionIntegrity(home, 'fixture')).resolves.toBeUndefined()
      } finally { await rm(home, {recursive:true, force:true}) }
    })
    test(`validates ${kind} case-variant ${ledgerName} ledger instead of treating it as legacy`, async () => {
      const home = createCodexProjectionFixture()
      try {
        const db = new DatabaseSync(join(home, file))
        try {
          db.exec(`ALTER TABLE _sqlx_migrations RENAME TO migration_ledger_source; ALTER TABLE migration_ledger_source RENAME TO ${ledgerName}; UPDATE ${ledgerName} SET checksum=zeroblob(48) WHERE version=1`)
        } finally { db.close() }
        await expect(assertThreadProjectionIntegrity(home, 'unprojected')).rejects.toThrow(/schema/)
      } finally { await rm(home, {recursive:true, force:true}) }
    })
    test(`rejects ${kind} reserved ${ledgerName} view instead of skipping migration validation`, async () => {
      const home = createCodexProjectionFixture()
      try {
        const db = new DatabaseSync(join(home, file))
        try {
          db.exec(`ALTER TABLE _sqlx_migrations RENAME TO migration_ledger_source; CREATE VIEW ${ledgerName} AS SELECT * FROM migration_ledger_source`)
        } finally { db.close() }
        await expect(assertThreadProjectionIntegrity(home, 'unprojected')).rejects.toThrow(/schema/)
      } finally { await rm(home, {recursive:true, force:true}) }
    })
  }
  test(`rejects ${kind} lowercase reserved ledger view without a history checkpoint`, async () => {
    const home = createCodexProjectionFixture()
    try {
      const db = new DatabaseSync(join(home, file))
      try {
        db.exec('ALTER TABLE _sqlx_migrations RENAME TO migration_ledger_source; CREATE VIEW _sqlx_migrations AS SELECT * FROM migration_ledger_source')
      } finally { db.close() }
      await expect(assertThreadProjectionIntegrity(home, 'unprojected')).rejects.toThrow(/schema/)
    } finally { await rm(home, {recursive:true, force:true}) }
  })
}
