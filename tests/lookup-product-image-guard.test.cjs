'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const image=require('../image-api.js');

test('lookup image field cannot silently become text-only generation',()=>{
  assert.throws(()=>image.assertProductImageFields([{id:'fld1',type:19,name:'白底图'}]),/本次未调用生图API/);
  assert.throws(()=>image.assertProductImageFields([{id:'fld2',type:19,name:'商品图片'}]),/查找引用/);
});
test('formula-based image also fails before paid request',()=>{
  assert.throws(()=>image.assertProductImageFields([{id:'fld3',type:20,name:'图片引用'}]),/公式/);
});
test('ordinary source attachment remains supported',()=>{
  assert.doesNotThrow(()=>image.assertProductImageFields([{id:'fld4',type:17,name:'白底图'}]));
});
test('ordinary text lookup with no photo field remains available for prompt',()=>{
  assert.doesNotThrow(()=>image.assertProductImageFields([{id:'fld5',type:19,name:'产品名称'}]));
});
test('existing attachment URL mapping uses original field and record ids',async()=>{
  const calls=[];
  const table={
    getCellValue:async (fid,rid)=>{calls.push(['getCellValue',fid,rid]);return [{name:'product.png',type:'image/png',token:'t1'}];},
    getCellAttachmentUrls:async(tokens,fid,rid)=>{calls.push(['getCellAttachmentUrls',tokens,fid,rid]);return ['https://example.com/temporary-image-url'];},
  };
  const urls=await image.attachmentUrls(table,'attachmentField','productRecord');
  assert.deepEqual(urls,['https://example.com/temporary-image-url']);
  assert.deepEqual(calls,[['getCellValue','attachmentField','productRecord'],['getCellAttachmentUrls',['t1'],'attachmentField','productRecord']]);
});
