const {test}=require('node:test');const assert=require('node:assert/strict');const api=require('../image-api.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64');
const config={base:'https://mock-api.test/v1',key:'fake-proxy-token',model:'gpt-image-2',text:'现有拼版Prompt',size:'2880x2880',n:10,autoCrop2x2:true};
function runtime(width=2880,height=2880,{exportFails=false}={}){
 const calls=[],clears=[];let closed=false;
 const canvas={getContext:()=>({drawImage:(bitmap,...coords)=>calls.push(coords),clearRect:(...coords)=>clears.push(coords)}),toBlob:callback=>callback(exportFails?null:new Blob([png],{type:'image/png'}))};
 return {runtime:{createImageBitmap:async()=>({width,height,close:()=>{closed=true;}}),document:{createElement:()=>canvas}},calls,clears,closed:()=>closed};
}
test('2x2 uses exact source rectangles in TL, TR, BL, BR order with no resizing',async()=>{
 const mock=runtime();const blobs=await api.crop2x2(new Blob([png]),undefined,mock.runtime);
 assert.equal(blobs.length,4);assert.deepEqual(mock.calls,[[0,0,1440,1440,0,0,1440,1440],[1440,0,1440,1440,0,0,1440,1440],[0,1440,1440,1440,0,0,1440,1440],[1440,1440,1440,1440,0,0,1440,1440]]);assert.equal(mock.clears.length,4);assert.ok(mock.closed());
});
test('non-square, odd dimensions, Canvas unavailability and failed export give clear errors',async()=>{
 for(const [w,h,pattern] of [[1024,1536,/不是正方形/],[1025,1025,/偶数/]]){const mock=runtime(w,h);await assert.rejects(api.crop2x2(new Blob([png]),undefined,mock.runtime),pattern);assert.equal(mock.calls.length,0);assert.ok(mock.closed());}
 await assert.rejects(api.crop2x2(new Blob([png]),undefined,{}),/createImageBitmap/);
 await assert.rejects(api.crop2x2(new Blob([png]),undefined,{createImageBitmap:()=>{},document:{createElement:()=>({getContext:()=>null})}}),/Canvas/);
 const mock=runtime(2880,2880,{exportFails:true});await assert.rejects(api.crop2x2(new Blob([png]),undefined,mock.runtime),/导出失败/);assert.ok(mock.closed());
});
test('crop mode forces exactly one paid request with n=1 and unchanged prompt/references',async()=>{
 let posts=0;
 const result=await api.generate({...config,imageUrls:['https://attachment.test/product'],brandImages:Array.from({length:4},()=>new Blob([png],{type:'image/png'}))},undefined,async(url,init)=>{
  if(url.includes('attachment.test'))return new Response(png,{headers:{'Content-Type':'image/png'}});
  posts++;assert.equal(init.body.get('n'),'1');assert.equal(init.body.get('prompt'),config.text);assert.equal(init.body.getAll('image[]').length,5);return Response.json({data:[{b64_json:png.toString('base64')}]});
 });assert.equal(posts,1);assert.equal(result.expectedCount,1);assert.equal(result.autoCrop2x2,true);
 let originals=0;
 await assert.rejects(api.write({result,table:{setCellValue:()=>assert.fail('must not overwrite')},base:{batchUploadFile:()=>assert.fail('crop failed, must not upload')},fid:'main',rid:'row',append:true,onOriginal:blob=>{originals++;assert.equal(blob.type,'image/png');}}),/createImageBitmap/);
 assert.equal(originals,1);assert.equal(posts,1);
});
test('non-square request is rejected before payment; uncropped n=4 remains unchanged',async()=>{
 await assert.rejects(api.generate({...config,size:'1024x1536'},undefined,()=>assert.fail('must not pay')),/正方形/);
 let posts=0;const result=await api.generate({...config,size:'1024x1024',n:4,autoCrop2x2:false},undefined,async(url,init)=>{posts++;assert.equal(JSON.parse(init.body).n,4);return Response.json({data:Array.from({length:4},()=>({b64_json:png.toString('base64')}))});});
 assert.equal(result.images.length,4);assert.equal(result.autoCrop2x2,false);assert.equal(posts,1);
});
test('unexpected multiple paid originals remain recoverable and never overwrite attachments',async()=>{
 const result={autoCrop2x2:true,images:[{b64:png.toString('base64')},{b64:png.toString('base64')}]};let retained=0;
 await assert.rejects(api.write({result,table:{setCellValue:()=>assert.fail('must not overwrite')},base:{batchUploadFile:()=>assert.fail('must not upload')},rid:'row',fid:'main',append:true,onOriginal:()=>{retained++;}}),/预期1张拼版图/);
 assert.equal(retained,2);
});
