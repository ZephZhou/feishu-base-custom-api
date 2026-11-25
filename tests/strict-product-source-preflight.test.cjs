'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=require('../image-api.js');

test('crop_2x2 requires an original attachment column and at least one resolved image',()=>{
  const direct=[{id:'fld_image',type:17,name:'生图源图'}];
  assert.doesNotThrow(()=>api.validateProductInputs(direct,'crop_2x2',1));
  assert.throws(()=>api.validateProductInputs(direct,'crop_2x2',0),/商品参考图为0张/);
  assert.throws(()=>api.validateProductInputs([{id:'sku',type:1,name:'SKU'}],'crop_2x2'),/真实商品附件列/);
});

test('crop_3x1 refuses lookup-derived image fields before any paid call',()=>{
  assert.throws(()=>api.validateProductInputs([{id:'lookup',type:19,name:'白底图'}],'crop_3x1'),/查找引用/);
  assert.throws(()=>api.validateProductInputs([{id:'formula',type:20,name:'图片'}],'crop_3x1'),/公式/);
});

test('normal image generation retains text-only compatibility',()=>{
  assert.doesNotThrow(()=>api.validateProductInputs([{id:'prompt',type:1,name:'文案'}],'standard',0));
});

test('direct attachment URL resolver receives current field and row context',async()=>{
  const calls=[];
  const table={
    getCellValue:async (fid,rid)=>{calls.push([fid,rid]);return[{token:'unique_current_row',name:'SKU567.png',type:'image/png'}]},
    getCellAttachmentUrls:async(tokens,fid,rid)=>{calls.push([tokens,fid,rid]);return['https://example.com/current-row.png']}
  };
  const urls=await api.attachmentUrls(table,'sourceField','currentRow');
  assert.deepEqual(urls,['https://example.com/current-row.png']);
  assert.deepEqual(calls,[['sourceField','currentRow'],[['unique_current_row'],'sourceField','currentRow']]);
});
