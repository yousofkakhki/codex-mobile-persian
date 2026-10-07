import { test, expect } from 'vitest'
import { rm } from 'node:fs/promises'
import { assertThreadProjectionIntegrity } from './threadProjectionIntegrity'
import { createCodexProjectionFixture } from './threadProjectionFixture'
import { STATE_SQLX_MIGRATION_SHA384, HISTORY_SQLX_MIGRATION_SHA384 } from './threadProjectionMigrations'

test('accepts healthy state58/history7 with complete verified official migration checksums', async () => {
  const home = createCodexProjectionFixture()
  try { await expect(assertThreadProjectionIntegrity(home, 'fixture')).resolves.toBeUndefined() }
  finally { await rm(home, {recursive: true, force: true}) }
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
