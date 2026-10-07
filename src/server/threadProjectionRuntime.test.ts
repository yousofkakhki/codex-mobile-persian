import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as integrity from './threadProjectionIntegrity'

test('package enforces the built-in SQLite runtime instead of an undeclared system sqlite3', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(pkg.engines.node).toBe('>=22.16.0')
  expect(readFileSync('src/server/threadProjectionIntegrity.ts', 'utf8')).not.toContain("execFile('sqlite3'")
})
test('rejects old runtimes with an explicit upgrade requirement', () => {
  expect(() => integrity.assertSQLiteRuntime('18.20.8')).toThrow(/Node.js >=22.16.0/)
  expect(() => integrity.assertSQLiteRuntime('20.20.0')).toThrow(/Node.js >=22.16.0/)
})
