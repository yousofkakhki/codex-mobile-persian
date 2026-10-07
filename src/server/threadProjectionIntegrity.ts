import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { stat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { STATE_SQLX_MIGRATION_SHA384, HISTORY_SQLX_MIGRATION_SHA384 } from './threadProjectionMigrations'


const require = createRequire(import.meta.url)

export function assertSQLiteRuntime(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 16)) {
    throw new Error('Node.js >=22.16.0 is required for bounded read-only SQLite integrity inspection; upgrade Node.js. No system sqlite3 fallback is used.')
  }
  try {
    if (typeof require('node:sqlite').DatabaseSync !== 'function') throw new Error('missing SQLite')
  } catch { throw new Error('Node.js >=22.16.0 with node:sqlite is required; active writer preserved.') }
}

/** Resolve locally before any serial RPC. Pin this exact directory in child launch args,
 * so unobserved project/system config cannot silently select a different database. */
export function resolveSQLiteHome(codexHome: string, env = process.env, cwd = process.cwd()): string {
  const configPath = join(codexHome, 'config.toml')
  let configured = ''
  if (existsSync(configPath)) {
    if (statSync(configPath).size > 1024 * 1024) throw new Error('Cannot resolve sqlite_home from oversized config; active writer preserved.')
    const raw = readFileSync(configPath, 'utf8')
    let topLevel = true
    for (const line of raw.split(/\r?\n/u)) {
      if (/^\s*\[/u.test(line)) topLevel = false
      if (!/^\s*(?:sqlite_home|["']sqlite_home["'])\s*=/u.test(line)) continue
      // Complex/multiline/ambiguous values never silently fall back to another directory.
      const match = line.match(/^\s*(?:sqlite_home|["']sqlite_home["'])\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/u)
      if (!topLevel || !match || configured) throw new Error('Cannot resolve layered sqlite_home safely; active writer preserved.')
      try { configured = match[1]!.startsWith('"') ? JSON.parse(match[1]!) : match[1]!.slice(1, -1) } catch {
        throw new Error('Cannot resolve sqlite_home safely; active writer preserved.')
      }
      if (!configured.trim()) throw new Error('Invalid sqlite_home; active writer preserved.')
    }
  }
  return configured ? resolve(codexHome, configured) : env.CODEX_SQLITE_HOME?.trim()
    ? resolve(cwd, env.CODEX_SQLITE_HOME.trim()) : resolve(codexHome)
}

async function readRows(path: string, table: string, columns: string[], sql: string, threadId: string): Promise<Array<Record<string, unknown>>> {
  assertSQLiteRuntime()
  const { DatabaseSync } = require('node:sqlite')
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 1000 })
    db.exec('PRAGMA query_only=ON')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version !== 0) throw new Error('unsupported schema version')
    const relations = db.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
    const migrationLedgers = relations.filter((row: Record<string, unknown>) =>
      typeof row.name === 'string' && row.name.toLowerCase() === '_sqlx_migrations')
    // SQLite identifiers are case-insensitive. Reserved views or other objects must
    // not make an incompatible ledger look like a ledger-less legacy database.
    if (migrationLedgers.length > 1 || migrationLedgers.some((row: Record<string, unknown>) => row.type !== 'table')) {
      throw new Error('unsupported schema migrations')
    }
    if (!relations.some((row: Record<string, unknown>) => row.type === 'table')) return [] // Lazily created projection.
    if (migrationLedgers.length === 1) {
      const ledger = db.prepare('PRAGMA table_info(_sqlx_migrations)').all()
      if (ledger.filter((row: Record<string, unknown>) => row.pk !== 0).length !== 1 ||
        !ledger.some((row: Record<string, unknown>) => row.name === 'version' && row.type === 'BIGINT' && row.pk === 1) ||
        !ledger.some((row: Record<string, unknown>) => row.name === 'success' && row.type === 'BOOLEAN' && row.notnull === 1 && row.pk === 0) ||
        !ledger.some((row: Record<string, unknown>) => row.name === 'checksum' && row.type === 'BLOB' && row.notnull === 1 && row.pk === 0)) throw new Error('unsupported schema migrations')
      const reviewed = table === 'threads' ? STATE_SQLX_MIGRATION_SHA384 : HISTORY_SQLX_MIGRATION_SHA384
      // Bound ledger hydration and reject unknown, failed, altered, or non-contiguous prefixes.
      // LIMIT includes one extra row so an oversized/future ledger cannot be truncated into acceptance.
      const migrations = db.prepare(`SELECT version, success, hex(checksum) AS checksum, typeof(checksum) AS checksum_type FROM _sqlx_migrations ORDER BY version LIMIT ${reviewed.length + 1}`).all()
      if (!migrations.length || migrations.length > reviewed.length || migrations.some((migration: Record<string, unknown>, index: number) =>
        migration.version !== index + 1 || migration.success !== 1 || migration.checksum_type !== 'blob' || migration.checksum !== reviewed[index])) {
        throw new Error('unsupported schema migrations')
      }
    }
    const actual = db.prepare(`PRAGMA table_info(${table})`).all()
    const required = table === 'threads'
      ? [['id', 'TEXT', 0, 1], ['rollout_path', 'TEXT', 1, 0]] as const
      : [['thread_id', 'TEXT', 0, 1], ['next_rollout_byte_offset', 'INTEGER', 1, 0], ['next_rollout_ordinal', 'INTEGER', 1, 0]] as const
    if (!columns.every(column => actual.some((row: Record<string, unknown>) => row.name === column)) ||
      actual.filter((row: Record<string, unknown>) => row.pk !== 0).length !== 1 ||
      !required.every(([name, type, notnull, pk]) => actual.some((row: Record<string, unknown>) =>
        row.name === name && row.type === type && row.notnull === notnull && row.pk === pk))) throw new Error('unsupported schema')
    return db.prepare(sql).all(threadId)
  } catch {
    throw new Error('Cannot verify thread history integrity: unsupported or unreadable SQLite schema; active writer preserved.')
  } finally { db?.close() }
}

/** Never let a known invalid durable checkpoint enter Codex's serial request handler.
 * No migration, projection, lock removal, rollout mutation, or writer acquisition occurs here. */
export async function assertThreadProjectionIntegrity(codexHome: string, threadId: string, inspectedSQLiteHome?: string): Promise<void> {
  const sqliteHome = inspectedSQLiteHome ?? resolveSQLiteHome(codexHome)
  let names: string[]
  try { names = await readdir(sqliteHome) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('Cannot inspect SQLite home; active writer preserved.')
  }
  if (names.some(name => /^(?:state|thread_history)_\d+\.sqlite$/u.test(name) && name !== 'state_5.sqlite' && name !== 'thread_history_1.sqlite')) {
    throw new Error('Unsupported SQLite schema version; active writer preserved.')
  }
  const historyDb = join(sqliteHome, 'thread_history_1.sqlite')
  const stateDb = join(sqliteHome, 'state_5.sqlite')
  if (!existsSync(historyDb)) {
    if (existsSync(stateDb)) await readRows(stateDb, 'threads', ['id', 'rollout_path'], 'SELECT rollout_path FROM threads WHERE id = ?', threadId)
    return
  }
  if (!existsSync(stateDb)) throw new Error('Cannot verify thread history integrity: missing state schema; active writer preserved.')
  const [checkpoint] = await readRows(historyDb, 'thread_history_projection_state', ['thread_id', 'next_rollout_byte_offset'],
    'SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id = ?', threadId)
  const [metadata] = await readRows(stateDb, 'threads', ['id', 'rollout_path'], 'SELECT rollout_path FROM threads WHERE id = ?', threadId)
  if (!checkpoint) return
  const offset = checkpoint.next_rollout_byte_offset
  // Missing metadata is handled by the supported RPC; never invent a path from the ID.
  if (typeof metadata?.rollout_path !== 'string' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Cannot verify thread history integrity; active writer preserved.')
  }
  // Compressed representation offsets refer to decoded bytes, not compressed file size.
  if (!metadata.rollout_path.endsWith('.jsonl')) return
  let size: number
  try { size = (await stat(metadata.rollout_path)).size } catch {
    throw new Error('Cannot verify thread history integrity; active writer preserved.')
  }
  if (offset > size) {
    throw new Error('Thread history integrity mismatch: projected checkpoint exceeds durable rollout. History access and turn start are blocked; active writer preserved. No history was repaired.')
  }
}
