import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ActivityStore } from './activityStore'
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})})
async function store(){const root=await mkdtemp(join(tmpdir(),'red-review-'));dirs.push(root);return new ActivityStore(root)}
it('SAFETY: quoted multiword credential fixtures must be entirely redacted before persistence',async()=>{const s=await store();await s.setDetail('a','m','password="SYNTHETIC_FIRST SYNTHETIC_SECOND"');expect((await s.detail('a','m')).text).not.toContain('SYNTHETIC_SECOND')})
it('SAFETY: a private-key body fixture split across output flushes must remain redacted',async()=>{const s=await store();await s.setDetail('a','m','-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NONKEY_FIRST\n',true);await s.setDetail('a','m','SYNTHETIC_NONKEY_SECOND\n-----END PRIVATE KEY-----\n',true);expect((await s.detail('a','m')).text).not.toContain('SYNTHETIC_NONKEY_SECOND')})
