import { afterEach, expect, it, vi } from 'vitest'
import { resumeThread, invalidateThreadResumeCache, rollbackThread, setThreadQueueState, updateThreadFileChanges, interruptThreadTurn, setThreadGoal } from './codexGateway'
afterEach(()=>{invalidateThreadResumeCache();vi.unstubAllGlobals()})
it('keeps active-writer history read-only and preserves actual provider instead of requested override',async()=>{
 const calls:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
  const body=JSON.parse(init.body);calls.push(body.method)
  if(body.method==='thread/resume') return new Response(JSON.stringify({error:'thread owned already has an active writer'}),{status:502})
  if(body.method==='thread/read') return new Response(JSON.stringify({result:{thread:{id:'owned',model:'actual-model',modelProvider:'openai',status:{type:'inProgress'},turns:[]}}}),{status:200})
  return new Response(JSON.stringify({result:{data:[],nextCursor:'older',backwardsCursor:null}}),{status:200})
 }))
 const [a,b]=await Promise.all([resumeThread('owned',{modelProvider:'custom_endpoint',model:'wanted'}),resumeThread('owned',{modelProvider:'custom_endpoint',model:'wanted'})])
 expect(a).toEqual(b);expect(a).toMatchObject({modelProvider:'openai',model:'actual-model',readOnly:true,olderCursor:'older'})
 expect(calls).toEqual(['thread/resume','thread/read','thread/turns/list'])
})

it('read-only contract prevents direct rollback, queue, file undo/redo, interrupt and goal mutations',async()=>{
 const methods:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
  const body=JSON.parse(init.body);methods.push(body.method);
  if(body.method==='thread/resume')return new Response(JSON.stringify({error:'thread readonly-api already has an active writer'}),{status:502});
  if(body.method==='thread/read'||body.method==='thread/rollback')return new Response(JSON.stringify({result:{thread:{id:'readonly-api',modelProvider:'openai',turns:[]}}}),{status:200});
  return new Response(JSON.stringify({result:{data:[],nextCursor:null}}),{status:200});
 }));
 await resumeThread('readonly-api'); const before=methods.length;
 await expect(rollbackThread('readonly-api',1)).rejects.toThrow(/read-only/);
 await expect(setThreadQueueState({})).rejects.toThrow(/read-only/);
 await expect(setThreadQueueState({'readonly-api':[{id:'q',text:'no',imageUrls:[],skills:[],fileAttachments:[],collaborationMode:'default'}]})).rejects.toThrow(/read-only/);
 for(const action of ['undo','redo'] as const){const result=await updateThreadFileChanges('readonly-api','t','/fixture',action);expect(result.changed).toBe(0);expect(result.errors.join()).toMatch(/read-only/);}
 await expect(interruptThreadTurn('readonly-api','t')).rejects.toThrow(/read-only/);
 await expect(setThreadGoal('readonly-api',{objective:'no'})).rejects.toThrow(/read-only/);
 expect(methods).toHaveLength(before);
});

it('legacy retry writer-conflict recovery stays bounded read-only instead of resuming a third time',async()=>{
 const methods:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
  const body=JSON.parse(init.body);methods.push(body.method)
  if(methods.length===1)return new Response(JSON.stringify({error:'Model provider `custom_endpoint` not found'}),{status:502})
  if(body.method==='thread/resume')return new Response(JSON.stringify({error:'thread legacy-owned already has an active writer'}),{status:502})
  if(body.method==='thread/read')return new Response(JSON.stringify({result:{thread:{model:'actual',modelProvider:'openai',turns:[]}}}),{status:200})
  return new Response(JSON.stringify({result:{data:[],nextCursor:null}}),{status:200})
 }))
 await expect(resumeThread('legacy-owned')).resolves.toMatchObject({readOnly:true,model:'actual',modelProvider:'openai'})
 expect(methods).toEqual(['thread/resume','thread/resume','thread/read','thread/turns/list'])
})
