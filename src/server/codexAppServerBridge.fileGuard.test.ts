import { test, expect, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'

test('rollback-files rejects an unowned writer before history RPC or project changes',async()=>{
 const home=await mkdtemp(join(tmpdir(),'resume-file-guard-'));vi.stubEnv('CODEX_HOME',home);
 const sentinel=join(home,'unchanged.txt');await writeFile(sentinel,'preserved');
 const bridge=createCodexBridgeMiddleware();const rpc=vi.fn(async()=>({thread:{turns:[],path:''}}));
 const shared=(globalThis as any).__codexRemoteSharedBridge__;
 const oldRpc=shared.appServer.rpc;shared.appServer.rpc=rpc;
 const req=Readable.from([JSON.stringify({threadId:'foreign',turnId:'turn',cwd:home})]) as any;
 req.method='POST';req.url='/codex-api/thread/rollback-files';req.headers={host:'127.0.0.1'};
 let output='';const res=new Writable({write(chunk,_encoding,done){output+=chunk.toString();done();}}) as any;
 res.setHeader=()=>{};
 try {
  await bridge(req,res,()=>{throw new Error('unexpected next')});
  expect(res.statusCode).toBe(409);expect(output).toMatch(/writer ownership/);
  expect(rpc).not.toHaveBeenCalled();expect(await readFile(sentinel,'utf8')).toBe('preserved');
 } finally {shared.appServer.rpc=oldRpc;bridge.dispose();vi.unstubAllEnvs();await rm(home,{recursive:true,force:true});}
});

test('queue-state replacement rejects unowned changes and omissions before state write',async()=>{
 const home=await mkdtemp(join(tmpdir(),'resume-queue-guard-'));vi.stubEnv('CODEX_HOME',home);
 const bridge=createCodexBridgeMiddleware();
 const req=Readable.from([JSON.stringify({foreign:[{id:'q',text:'not authorized',imageUrls:[]}]})]) as any;req.method='PUT';req.url='/codex-api/thread-queue-state';req.headers={host:'127.0.0.1'};
 let output='';const res=new Writable({write(chunk,_encoding,done){output+=chunk.toString();done();}}) as any;res.setHeader=()=>{};
 try{await bridge(req,res,()=>{throw new Error('unexpected next')});expect(res.statusCode).toBe(409);expect(output).toMatch(/writer ownership/);}finally{bridge.dispose();vi.unstubAllEnvs();await rm(home,{recursive:true,force:true});}
});
