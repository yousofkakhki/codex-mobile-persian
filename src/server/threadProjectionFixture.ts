// Exact official SQL inputs; SHA384 is checked before every fixture migration.
// Baseline: 6b9826e3aa83b1a5947db50f4332cb9c65f1b340; reviewed additions:
// d27764b82f7118f674371e6d6e76271d9d606edb. No production state is copied.
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
export const codexMigrationFixture = JSON.parse(readFileSync(new URL('./testFixtures/codexMigrations.json', import.meta.url), 'utf8')) as {
  migrations: Array<{kind: 'state' | 'history'; version: number; description: string; sha384: string; sql: string}>
}
export function createCodexProjectionFixture(options: {stateVersion?: number; historyVersion?: number; offset?: number | bigint | string | Uint8Array; legacy?: boolean} = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-reviewed-schema-'))
  const rollout = join(home, 'fixture.jsonl')
  writeFileSync(rollout, '{}\n')
  for (const kind of ['state', 'history'] as const) {
    const max = kind === 'state' ? (options.stateVersion ?? 58) : (options.historyVersion ?? 7)
    const db = new DatabaseSync(join(home, kind === 'state' ? 'state_5.sqlite' : 'thread_history_1.sqlite'))
    try {
      db.exec('BEGIN')
      db.exec('CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)')
      for (const migration of codexMigrationFixture.migrations.filter(row => row.kind === kind && row.version <= max)) {
        if (createHash('sha384').update(migration.sql).digest('hex').toUpperCase() !== migration.sha384) throw new Error('Fixture SQL checksum mismatch')
        db.exec(migration.sql)
        db.prepare('INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time) VALUES(?,?,1,?,0)').run(migration.version, migration.description, Buffer.from(migration.sha384, 'hex'))
      }
      if (kind === 'history') {
        db.prepare('INSERT INTO thread_history_projection_state(thread_id, next_rollout_byte_offset, next_rollout_ordinal) VALUES(?,?,?)').run('fixture', options.offset ?? 3, 1)
      } else {
        db.prepare(`INSERT INTO threads(id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode)
          VALUES(?,?,1,1,'cli','fixture','/fixture','Fixture','read-only','never')`).run('fixture', rollout)
      }
      if (options.legacy) db.exec('DROP TABLE _sqlx_migrations')
      db.exec('COMMIT')
    } finally { db.close() }
  }
  return home
}
