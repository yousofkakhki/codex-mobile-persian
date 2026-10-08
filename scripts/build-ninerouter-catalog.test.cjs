const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildCatalog, extractBundledCatalog } = require('./build-ninerouter-catalog.cjs')
test('preserves bundled models and exact aliases while keeping per-model context', () => {
 const bundled={models:[{slug:'gpt-5.6-sol',context_window:272000,model_messages:{instructions:'real template'},default_reasoning_level:'low'}]}
 const output=buildCatalog(bundled,{data:[{id:'cx/gpt-6.1-sol',context_length:1050000},{id:'cx/gpt-5.6-sol[1m]',context_length:872000}]})
 assert.equal(output.models[0].context_window,272000)
 assert.equal(output.models[1].context_window,1050000)
 assert.equal(output.models[2].slug,'cx/gpt-5.6-sol[1m]')
 assert.equal(output.models[2].context_window,872000)
 assert.deepEqual(output.models[1].model_messages,bundled.models[0].model_messages)
 assert.equal(bundled.models.length,1)
 assert.equal(output.models[1].prefer_websockets,false)
})
test('fails closed for unrecognized descriptors and binary formats',()=>{
 assert.throws(()=>buildCatalog({models:[{slug:'other'}]},{data:[{id:'cx/unknown',context_length:1000}]}))
 assert.throws(()=>extractBundledCatalog(Buffer.from('no catalog')))
 const data={models:[{slug:'m',supported_reasoning_levels:[],description:'brace } in string'}]}
 const binary=Buffer.from('prefix'+JSON.stringify(data,null,2)+'suffix')
 assert.deepEqual(extractBundledCatalog(binary),data)
})
test('does not postpone compaction when a gateway advertises a larger context', () => {
 const bundled={models:[{slug:'gpt-5.6-sol',context_window:272000,auto_compact_token_limit:null}]}
 const output=buildCatalog(bundled,{data:[{id:'cx/gpt-6.1-sol',context_length:1050000}]})
 assert.equal(output.models[1].context_window,1050000)
 assert.equal(output.models[1].auto_compact_token_limit,244800)
 assert.equal(bundled.models[0].auto_compact_token_limit,null)
})
test('preserves explicit compaction limits and clamps them to smaller gateway windows', () => {
 const bundled={models:[{slug:'gpt-5.6-sol',context_window:272000,auto_compact_token_limit:180000}]}
 const output=buildCatalog(bundled,{data:[{id:'cx/gpt-6.1-sol',context_length:1050000},{id:'cx/gpt-5.6-sol',context_length:100000}]})
 assert.equal(output.models[1].auto_compact_token_limit,180000)
 assert.equal(output.models[2].auto_compact_token_limit,90000)
})
test('rejects descriptors without a valid native context for safe compaction', () => {
 const bundled={models:[{slug:'gpt-5.6-sol',context_window:null}]}
 assert.throws(()=>buildCatalog(bundled,{data:[{id:'cx/gpt-6.1-sol',context_length:1050000}]}))
})
