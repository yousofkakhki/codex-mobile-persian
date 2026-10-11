import { mkdtemp,rm,readFile,readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach,expect,it } from 'vitest'
import { ActivityStore } from './activityStore'
import { ActivityRecorder } from './activityRecorder'
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'safety-recovery-review-'));roots.push(root);const store=new ActivityStore(root);return {root,store,recorder:new ActivityRecorder(store)}}
it('SAFETY: late activity recovery must not recreate a sidecar after confirmed deletion',async()=>{const {root,store,recorder}=await fixture();let release!:(value:unknown)=>void;const recovery=recorder.recover('a',{rpc:async()=>new Promise(resolve=>{release=resolve})});while(!release)await new Promise(resolve=>setTimeout(resolve,1));await recorder.afterRpc('thread/delete',{threadId:'a'},{},null);release({data:[],nextCursor:'older'});await recovery;await expect(readdir(join(root,createHash('sha256').update('a').digest('hex')))).rejects.toMatchObject({code:'ENOENT'})})
it('SAFETY: restart recovers an acknowledged snapshot that is missing but whose journal record remains',async()=>{const {root,store}=await fixture();await store.append({id:'m',threadId:'a',turnId:'t',itemId:null,goalCreatedAt:null,kind:'command',status:'completed',title:'Synthetic',summary:'',startedAt:null,durationMs:null,hasDetail:false,reconstructed:false});await rm(join(root,createHash('sha256').update('a').digest('hex'),'entries',createHash('sha256').update('m').digest('hex')+'.json'));const restart=new ActivityStore(root);await restart.page('a');expect((await restart.lookup('a','m'))?.id).toBe('m')})
