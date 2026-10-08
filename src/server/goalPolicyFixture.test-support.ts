// @ts-nocheck
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { createContext, runInContext } from 'node:vm'
import { appendGoalBudgetAuditRecord } from './goalBudgetAudit'
import { applyAppServerPermissionDefaults, readAppServerPermissionIntent, readAppServerPermissionDefaults, prepareAppServerHotPermissionOverrides, mergeAppServerHotPermissionOverrides } from './appServerPermissionDefaults'
const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(resolve('src/server/codexAppServerBridge.ts'), 'utf8')
const begin = source.indexOf('class AppServerProcess {')
const end = source.indexOf('\nexport class BackendQueueProcessor', begin)
const js = ts.transpileModule(source.slice(begin, end) + '\nglobalThis.App = AppServerProcess', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
export async function createGoalPolicyFixture(nativeRpc, threadId) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdout.setEncoding = child.stderr.setEncoding = () => {}
  child.stdin = { end() {}, write(line) {
    const request = JSON.parse(line)
    if (!request.id) return true
    queueMicrotask(async () => {
      try {
        const result = request.method === 'initialize' ? {}
          : request.method === 'config/read' ? { config: { sqlite_home: '/fixture-sqlite-home' } }
          : request.method === 'thread/resume' ? { thread: { id: threadId }, modelProvider: 'fixture' }
          : request.method === 'thread/read' ? { thread: { id: threadId, status: { type: 'idle' } } }
          : await nativeRpc(request.method, request.params)
        child.stdout.emit('data', JSON.stringify({ id: request.id, result }) + '\n')
      } catch (error) { child.stdout.emit('data', JSON.stringify({ id: request.id, error: { code: -32000, message: error.message } }) + '\n') }
    })
    return true
  } }
  child.kill = () => { throw Error('Fixture must preserve writer') }
  const context = createContext({ spawn: () => child, queueMicrotask, resolve, join,
    applyAppServerPermissionDefaults, readAppServerPermissionIntent, readAppServerPermissionDefaults, prepareAppServerHotPermissionOverrides, mergeAppServerHotPermissionOverrides,
    THREAD_RESPONSE_TURN_LIMIT: 10, STREAM_EVENT_BUFFER_LIMIT: 200,
    assertThreadProjectionIntegrity: async () => {},
    asRecord: value => value && typeof value === 'object' && !Array.isArray(value) ? value : null,
    readNonEmptyString: value => typeof value === 'string' ? value.trim() : '',
    buildAppServerArgs: () => ['app-server'], getProviderCompatibilityConfigArgs: () => [],
    getCodexHomeDir: () => '/fixture-never-accessed', resolveSQLiteHome: () => '/fixture-sqlite-home',
    FREE_MODE_STATE_FILE: 'fixture-never-read', ensureDefaultFreeModeStateForMissingAuthSync: () => null,
    getSpawnInvocation: (command, args) => ({ command, args }), resolveCodexCommand: () => 'synthetic',
    process: { env: {} }, setTimeout: () => ({ unref() {} }), clearTimeout() {}, appendGoalBudgetAuditRecord,
  })
  runInContext(js, context)
  const app = new context.App()
  await app.rpc('config/read', {})
  await app.rpc('thread/resume', { threadId, excludeTurns: true })
  return app
}
