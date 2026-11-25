'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../image-api.js');

function lookupCell(id){return {type:17,value:[{file_token:'token-'+id,name:id+'.png',type:'image/png'}]};}

test('lookup image attachment nested result is recognized',()=>{
  assert.deepEqual(api.lookupImages(lookupCell('A')).map(a=>a.token),['token-A']);
  assert.deepEqual(api.lookupImages({type:1,value:['text only']}),[]);
});
test('each SKU resolves its own image tokens and URLs',async()=>{
  const calls=[];
  const table={
    getCellValue:async(fid,rid)=>lookupCell(rid),
    getCellAttachmentUrls:async(tokens,fid,rid)=>{
      calls.push([tokens,fid,rid]);
      assert.deepEqual(tokens,['token-'+rid]);
      return ['https://cdn.example.org/'+rid+'.png'];
    }
  };
  assert.deepEqual(await api.lookupAttachmentUrls(table,'lookup-field','record-1'),['https://cdn.example.org/record-1.png']);
  assert.deepEqual(await api.lookupAttachmentUrls(table,'lookup-field','record-2'),['https://cdn.example.org/record-2.png']);
  assert.equal(calls.length,2);
});
test('missing lookup token fails before paid request',async()=>{
  await assert.rejects(api.lookupAttachmentUrls({getCellValue:async()=>({type:17,value:[]})},'f','r'),/本次未调用生图API/);
});
test('lookup permission failure stops before image API request',async()=>{
  await assert.rejects(api.lookupAttachmentUrls({getCellValue:async()=>lookupCell('A'),getCellAttachmentUrls:async()=>{throw Error('denied')}},'f','r'),/源表字段ID和源记录ID/);
});
test('formula image guard stays in effect',()=>{
  assert.throws(()=>api.assertProductImageFields([{name:'白底图',type:20}]),/公式图片输入列/);
  assert.doesNotThrow(()=>api.assertProductImageFields([{name:'白底图',type:19}]));
});
