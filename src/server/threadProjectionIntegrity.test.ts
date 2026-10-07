import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { assertThreadProjectionIntegrity } from './threadProjectionIntegrity'
import { createCodexProjectionFixture } from './threadProjectionFixture'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

async function fixture(offset: number) {
 return createCodexProjectionFixture({ stateVersion: 54, historyVersion: 6, offset, legacy: true })
}

test('checks checkpoint against exact durable size without modifying either database',async()=>{
 const home=await fixture(99999)
 try {
  await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/history integrity mismatch/)
  const db=new DatabaseSync(join(home,'thread_history_1.sqlite'),{readOnly:true})
  try { expect(db.prepare('SELECT next_rollout_byte_offset FROM thread_history_projection_state').get().next_rollout_byte_offset).toBe(99999) } finally { db.close() }
 } finally { await rm(home,{recursive:true,force:true}) }
})
test('accepts an empty not-yet-materialized projection database', async()=>{
 const home=await mkdtemp(join(tmpdir(),'resume-new-projection-test-'))
 const history=new DatabaseSync(join(home,'thread_history_1.sqlite'));history.close()
 const state=new DatabaseSync(join(home,'state_5.sqlite'));state.close()
 try {await expect(assertThreadProjectionIntegrity(home,'fixture')).resolves.toBeUndefined()} finally {await rm(home,{recursive:true,force:true})}
})
test('checks configured sqlite_home before CODEX_SQLITE_HOME and CODEX_HOME', async()=>{
 const home=await mkdtemp(join(tmpdir(),'resume-config-home-'));
 const configured=await fixture(99999); const envHome=await fixture(3);
 const before=process.env.CODEX_SQLITE_HOME;
 try {
  process.env.CODEX_SQLITE_HOME=envHome;
  await writeFile(join(home,'config.toml'),`sqlite_home = ${JSON.stringify(configured)} # selected before environment\n`);
  await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/history integrity mismatch/);
  await rm(join(home,'config.toml'));
  process.env.CODEX_SQLITE_HOME=configured;
  await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/history integrity mismatch/);
 } finally {
  if(before===undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME=before;
  await Promise.all([home,configured,envHome].map(p=>rm(p,{recursive:true,force:true})));
 }
});
test('rejects unsupported schema filenames and malformed projection schema without mutation',async()=>{
 const home=await fixture(3);
 try {
  const db=new DatabaseSync(join(home,'thread_history_2.sqlite'));db.close();
  await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/Unsupported.*schema/);
  await rm(join(home,'thread_history_2.sqlite'));
  const history=new DatabaseSync(join(home,'thread_history_1.sqlite'));
  history.exec('DROP TABLE thread_history_projection_state; CREATE TABLE unexpected_schema(id TEXT)');history.close();
  const digest=async()=>createHash('sha256').update(await readFile(join(home,'thread_history_1.sqlite'))).digest('hex');
  const before=await digest();
  await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/schema/);
  expect(await digest()).toBe(before);
 } finally {await rm(home,{recursive:true,force:true})}
});

test('does not mistake a populated incompatible known-version database for an empty projection',async()=>{
 const home=await fixture(3);
 try {
  const db=new DatabaseSync(join(home,'thread_history_1.sqlite'));
  db.exec('DROP TABLE thread_history_projection_state; CREATE TABLE unsupported(id TEXT)');db.close();
  await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/schema/);
 } finally {await rm(home,{recursive:true,force:true})}
});

test('rejects unsupported PRAGMA schema version without creating or rewriting state',async()=>{
 const home=await fixture(3);try {
  const db=new DatabaseSync(join(home,'thread_history_1.sqlite'));db.exec('PRAGMA user_version=77');db.close();
  await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/schema/);
 }finally{await rm(home,{recursive:true,force:true})}
});

test('rejects future or incomplete SQLx migrations in supported filenames',async()=>{
 const home=await fixture(3);try{
  const db=new DatabaseSync(join(home,'thread_history_1.sqlite'));
  db.exec('CREATE TABLE _sqlx_migrations(version INTEGER, success INTEGER); INSERT INTO _sqlx_migrations VALUES(7,1)');db.close();
  await expect(assertThreadProjectionIntegrity(home,'fixture')).rejects.toThrow(/schema/);
 }finally{await rm(home,{recursive:true,force:true})}
});

test('validates state schema even when this thread has no history checkpoint',async()=>{
 const home=await fixture(3);try{
  const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('PRAGMA user_version=99');db.close();
  await expect(assertThreadProjectionIntegrity(home,'unprojected')).rejects.toThrow(/schema/);
 }finally{await rm(home,{recursive:true,force:true})}
});

test('fails closed for unsupported state-only schema before any history projection exists',async()=>{
 const home=await fixture(3);try{
  await rm(join(home,'thread_history_1.sqlite'));
  const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('PRAGMA user_version=99');db.close();
  await expect(assertThreadProjectionIntegrity(home,'unprojected')).rejects.toThrow(/schema/);
 }finally{await rm(home,{recursive:true,force:true})}
});

test('accepts intact prefix and missing legacy projection',async()=>{
 const home=await fixture(3)
 try {
  await expect(assertThreadProjectionIntegrity(home,'fixture')).resolves.toBeUndefined()
  await expect(assertThreadProjectionIntegrity(home,'unprojected')).resolves.toBeUndefined()
 } finally { await rm(home,{recursive:true,force:true}) }
})
