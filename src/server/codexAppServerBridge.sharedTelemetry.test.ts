import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
it('attaches telemetry once to the compatible shared writer instead of disposing or replacing it', () => {
 const source = readFileSync(new URL('./codexAppServerBridge.ts', import.meta.url), 'utf8')
 const begin = source.indexOf("const SHARED_BRIDGE_KEY =")
 const end = source.indexOf('async function loadAllThreadsForSearch', begin)
 const code = ts.transpileModule(source.slice(begin,end)+'\nglobalThis.getShared = getSharedBridgeState;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
 const appServer = { dispose: vi.fn(), setActivityRecorder: vi.fn() }
 const existing = { version:'experimental-api-v2', appServer, terminalManager:{}, backendQueueProcessor:{} }
 const exercise = (candidate:string) => {
 const context:any = { __codexRemoteSharedBridge__:existing, getCodexHomeDir:()=>'/fixture-no-read', join:(...parts:string[])=>parts.join('/'), recordQueueActivity:null,
  ActivityStore: class { constructor(public root:string){} }, ActivityRecorder:class { constructor(public store:unknown){} recordQueue(){} } }
 vm.runInNewContext(candidate, context)
 return context
 }
 const oldCode = code.replace("const SHARED_BRIDGE_VERSION = 'experimental-api-v2'", "const SHARED_BRIDGE_VERSION = 'activity-api-v1'")
 expect(() => exercise(oldCode).getShared()).toThrow()
 expect(appServer.dispose).toHaveBeenCalledTimes(1)
 appServer.dispose.mockClear()
 const context=exercise(code)
 const first = context.getShared(), second=context.getShared()
 expect(first).toBe(existing);expect(second).toBe(existing)
 expect(appServer.dispose).not.toHaveBeenCalled()
 expect(appServer.setActivityRecorder).toHaveBeenCalledTimes(1)
 expect(first.activityStore.root).toBe('/fixture-no-read/web-activity-v1')
})
