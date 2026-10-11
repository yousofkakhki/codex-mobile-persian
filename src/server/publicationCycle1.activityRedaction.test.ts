import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ActivityStore, redactActivityText } from './activityStore'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'publication-cycle1-redaction-'))
  directories.push(root)
  return { root, store: new ActivityStore(root) }
}
// All value bodies are fabricated markers, not credentials or key material.
const marker = (part: string) => 'CYCLE_FIXTURE_' + part
const begin = '-----BEGIN PRIVATE KEY-----\n'
const end = '\n-----END PRIVATE KEY-----\n'
async function persisted(root: string): Promise<string> {
  let result = ''
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    result += entry.isDirectory() ? await persisted(path) : await readFile(path, 'utf8')
  }
  return result
}

it('PUB-ACT-01 masks the entire quoted multiword and escaped value, without swallowing subsequent public text', () => {
  const result = redactActivityText('password="' + marker('FIRST') + ' \\" ' + marker('LAST') + '" public')
  expect(result.includes(marker('FIRST')) || result.includes(marker('LAST'))).toBe(false)
  expect(result).toContain('public')
  expect(redactActivityText("secret='" + marker('SINGLE') + " second word' public")).toBe('secret=[redacted] public')
})

it('PUB-ACT-01 keeps open private-key redaction across separate flushes and restart, even with a long body', async () => {
  const { root, store } = await fixture()
  await store.setDetail('a', 'm', begin + marker('FIRST'))
  await new ActivityStore(root).setDetail('a', 'm', marker('CONTINUATION').repeat(400) + end + 'public tail', true)
  const disk = await persisted(root)
  expect(disk.includes(marker('FIRST')) || disk.includes(marker('CONTINUATION'))).toBe(false)
  expect((await store.detail('a', 'm')).text).toContain('public tail')
})

it('PUB-ACT-01 keeps quoted-value and unquoted-value redaction state per detail across restart', async () => {
  const { root, store } = await fixture()
  await store.setDetail('a', 'm', 'api_')
  await store.setDetail('a', 'm', 'key="' + marker('FIRST') + ' ', true)
  await new ActivityStore(root).setDetail('a', 'm', marker('LAST') + '" public\ntoken=' + marker('UNQUOTED'), true)
  await new ActivityStore(root).setDetail('a', 'm', marker('SUFFIX') + '\nvisible', true)
  await store.setDetail('b', 'm', 'other thread public')
  const disk = await persisted(root)
  expect(['FIRST', 'LAST', 'UNQUOTED', 'SUFFIX'].some(value => disk.includes(marker(value)))).toBe(false)
  expect((await store.detail('a', 'm')).text).toContain('visible')
  expect((await store.detail('b', 'm')).text).toBe('other thread public')
})

it('PUB-ACT-01 recognizes private-key delimiters split into one-character flushes without persisting bodies', async () => {
  const { root, store } = await fixture()
  for (const character of begin + marker('BODY') + end + 'public') await store.setDetail('a', 'm', character, true)
  expect((await persisted(root)).includes(marker('BODY'))).toBe(false)
  expect((await store.detail('a', 'm')).text).toContain('public')
})

it('PUB-ACT-01 private-key recognition takes precedence over an unquoted credential assignment', async () => {
  const { root, store } = await fixture()
  const source = 'secret=' + begin + marker('ASSIGNMENT_BODY') + end + 'public'
  expect(redactActivityText(source).includes(marker('ASSIGNMENT_BODY'))).toBe(false)
  for (const character of source) await store.setDetail('a', 'assigned', character, true)
  expect((await persisted(root)).includes(marker('ASSIGNMENT_BODY'))).toBe(false)
  expect((await store.detail('a', 'assigned')).text).toContain('public')
})

it('PUB-ACT-01 resumes the quoted credential mask after its embedded key ends', async () => {
  const { root, store } = await fixture()
  await store.setDetail('a', 'quoted-key', 'secret="' + begin + marker('KEY_BODY'))
  await new ActivityStore(root).setDetail('a', 'quoted-key', end + marker('QUOTED_SUFFIX') + '" public', true)
  expect((await persisted(root)).includes(marker('QUOTED_SUFFIX'))).toBe(false)
  expect((await store.detail('a', 'quoted-key')).text).toContain('public')
})
