// @ts-nocheck
import { Readable, Writable } from 'node:stream';
import { afterEach, test, expect, vi } from 'vitest';
import { createGoalPolicyFixture } from './goalPolicyFixture.test-support'
import { createCodexBridgeMiddleware } from './codexAppServerBridge';
vi.mock('./goalBudgetAudit',async()=>({...await vi.importActual('./goalBudgetAudit'),appendGoalBudgetAuditRecord:vi.fn(async()=>{})}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
const good={threadId:'owned',objective:'Durable objective',status:'paused',tokenBudget:50,tokensUsed:5,timeUsedSeconds:12,createdAt:1,updatedAt:2};
async function req(params,opts={}){
 let store=opts.before===null?null:{...good,...opts.before};
 const rpc=vi.fn(async(method,p)=>{
  if(method==='thread/goal/get')return {goal:store};
  if(method==='thread/goal/set'){
   store={...(store??{...good,status:'active',tokensUsed:0,timeUsedSeconds:0}),...p,...opts.after};
   return {goal:store};
  }
  throw new Error('unexpected fixture RPC '+method);
 });
 vi.stubGlobal('__codexRemoteSharedBridge__',{version:'experimental-api-v2',appServer: await createGoalPolicyFixture(rpc, 'owned'),terminalManager:{},methodCatalog:{},telegramBridge:{},backendQueueProcessor:{}});
 const middleware=createCodexBridgeMiddleware(opts.noOwnerCallback?{}:{isOwnerAuthorized:vi.fn(()=>Object.prototype.hasOwnProperty.call(opts,'auth')?opts.auth:true)});
 const request=Readable.from([JSON.stringify({method:'thread/goal/set',params})]);request.method='POST';request.url='/codex-api/rpc';request.headers={};
 let output='';const response=new Writable({write(c,e,d){output+=c.toString();d();}});response.setHeader=()=>{};
 await middleware(request,response,()=>{throw new Error('next');});
 const out={status:response.statusCode,body:JSON.parse(output),writes:rpc.mock.calls.filter(([m])=>m==='thread/goal/set'),reads:rpc.mock.calls.filter(([m])=>m==='thread/goal/get')};
 console.log('INDEPENDENT_MIDDLEWARE',JSON.stringify(out));return out;
}
const confirmed={threadId:'owned',status:'active',tokenBudget:100,ownerConfirmed:true};

test.each([false,0,null,undefined])('auth default fail-closed %j',async auth=>{const r=await req(confirmed,{auth});expect(r.status).toBe(403);expect(r.writes).toHaveLength(0);});
test('missing owner callback rejects',async()=>{const r=await req(confirmed,{noOwnerCallback:true});expect(r.status).toBe(403);expect(r.writes).toHaveLength(0);});
test.each(['true',1,{}])('REGRESSION owner authorization must be actual true, not truthy %j',async auth=>{const r=await req(confirmed,{auth});expect(r.status).toBe(403);expect(r.writes).toHaveLength(0);});
test.each([undefined,null,false,0,1,'true',{}])('confirmation requires actual true %j',async ownerConfirmed=>{const r=await req({...confirmed,ownerConfirmed});expect(r.status).toBe(400);expect(r.writes).toHaveLength(0);});
test.each([null,0,-1,1.1,9007199254740992,'100',{},true])('finite safe integer budget validation %j',async tokenBudget=>{const r=await req({...confirmed,tokenBudget});expect(r.status).toBe(400);expect(r.writes).toHaveLength(0);});
test.each([5,4])('budget must exceed current usage %j',async tokenBudget=>{const r=await req({...confirmed,tokenBudget});expect(r.status).toBe(400);expect(r.writes).toHaveLength(0);});
test.each([null,undefined,-1,1.25,'5',9007199254740992])('REGRESSION malformed pre-read tokensUsed rejects before mutation %j',async tokensUsed=>{const r=await req(confirmed,{before:{tokensUsed}});expect(r.writes).toHaveLength(0);expect(r.status).toBeGreaterThanOrEqual(400);});
test.each([{threadId:'foreign'},{objective:'rewritten'},{tokensUsed:0},{timeUsedSeconds:0},{createdAt:2},{status:'paused'},{tokenBudget:101}])('post-write identity/accounting/status mismatch rejects %j',async after=>{const r=await req(confirmed,{after});expect(r.status).toBe(502);});
test('pre-write target mismatch rejects without dispatch',async()=>{const r=await req(confirmed,{before:{threadId:'foreign'}});expect(r.status).toBe(502);expect(r.writes).toHaveLength(0);});
test('REGRESSION confirmation bridge-local flag stripped also for absent-budget status edit',async()=>{const r=await req({threadId:'owned',status:'paused',ownerConfirmed:true});expect(r.status).toBe(200);expect(r.writes[0][1]).not.toHaveProperty('ownerConfirmed');});
test('implicit no-budget creation rejected',async()=>{const r=await req({threadId:'owned',objective:'New Goal',status:'active'},{before:null});expect(r.status).toBe(400);expect(r.writes).toHaveLength(0);});
test.each([{objective:''},{objective:null},{objective:{} }])('malformed replacement objective rejected %j',async item=>{const r=await req({...confirmed,...item});expect(r.status).toBe(400);expect(r.writes).toHaveLength(0);});
test('positive owned finite objective creation strips local confirmation',async()=>{const r=await req({...confirmed,objective:'  New Goal  '},{before:null});expect(r.status).toBe(200);expect(r.writes[0][1]).toEqual({threadId:'owned',status:'active',tokenBudget:100,objective:'New Goal'});});
test('positive owned objective edit explicit budget preserves accounting',async()=>{const r=await req({...confirmed,objective:'New objective',status:'paused'});expect(r.status).toBe(200);expect(r.body.result.goal).toMatchObject({tokensUsed:5,timeUsedSeconds:12,createdAt:1,objective:'New objective'});});
test('positive budget-only recovery preserves objective and accounting',async()=>{const r=await req(confirmed,{before:{status:'budgetLimited'}});expect(r.status).toBe(200);expect(r.writes[0][1]).toEqual({threadId:'owned',status:'active',tokenBudget:100});expect(r.body.result.goal).toMatchObject({objective:good.objective,tokensUsed:5,timeUsedSeconds:12,createdAt:1});});
test('positive existing status-only pause does not invent/change budget',async()=>{const r=await req({threadId:'owned',status:'paused'});expect(r.status).toBe(200);expect(r.writes[0][1]).toEqual({threadId:'owned',status:'paused'});});

test('caller spoofed isOwnerAuthorized field cannot bypass absent callback',async()=>{const r=await req({...confirmed,isOwnerAuthorized:true,ownerAuthorized:true},{noOwnerCallback:true});expect(r.status).toBe(403);expect(r.writes).toHaveLength(0);});
test.each([null,[],false,'bad'])('malformed parameter containers deny without mutation %j',async params=>{const r=await req(params,{before:null});expect(r.status).toBeGreaterThanOrEqual(400);expect(r.writes).toHaveLength(0);});

test('REGRESSION legacy null-budget paused Goal cannot be rearmed by non-owner status-only write',async()=>{const r=await req({threadId:'owned',status:'active'},{auth:false,before:{status:'paused',tokenBudget:null}});expect(r.status).toBeGreaterThanOrEqual(400);expect(r.writes).toHaveLength(0);});
test('CONTROL finite exhausted status activation is normalized by native, not a new blanket policy',async()=>{const r=await req({threadId:'owned',status:'active'},{auth:false,before:{status:'budgetLimited',tokenBudget:5,tokensUsed:5},after:{status:'budgetLimited'}});expect(r.status).toBe(200);expect(r.body.result.goal.status).toBe('budgetLimited');});
test.each([{timeUsedSeconds:null},{timeUsedSeconds:-1},{timeUsedSeconds:'12'},{timeUsedSeconds:Infinity},{createdAt:null},{createdAt:-1},{createdAt:'1'},{updatedAt:null},{objective:''},{objective:'   '},{status:'unknown'},{threadId:''}])('REGRESSION malformed Goal snapshot rejects before every set %j',async before=>{const r=await req(confirmed,{before});expect(r.status).toBeGreaterThanOrEqual(400);expect(r.writes).toHaveLength(0);});

test('positive paused finite Goal with remaining usage can be activated without altering cap',async()=>{const r=await req({threadId:'owned',status:'active'},{auth:false,before:{status:'paused',tokenBudget:50,tokensUsed:5}});expect(r.status).toBe(200);expect(r.body.result.goal).toMatchObject({tokenBudget:50,tokensUsed:5,status:'active'});});
