const {test}=require('node:test');const assert=require('node:assert/strict');
const rules=require('../server/image-rules.js'),options=require('../image-options.js'),api=require('../image-api.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64');
function runtime(width=3456,height=2048){const calls=[];let closed=false;const canvas={getContext:()=>({clearRect:()=>{},drawImage:(image,...args)=>calls.push(args)}),toBlob:cb=>cb(new Blob([png],{type:'image/png'}))};return {runtime:{createImageBitmap:async()=>({width,height,close:()=>{closed=true;}}),document:{createElement:()=>canvas}},calls,closed:()=>closed};}
test('fresh defaults specify strategies/sizes; legacy prompts, sizes and extra fields are preserved',()=>{
 const defaults=options.loadTemplates({getItem:()=>null});assert.deepEqual(defaults.map(t=>[t.generationMode,t.n,t.size]),[['crop_2x2',1,'2880x2880'],['crop_3x1',1,'3456x2048']]);
 const old=[{id:'main',name:'旧主图',prompt:'原始Prompt含3张4张',n:1,size:'1024x1024',autoCrop2x2:true,extra:'保留'}, {id:'detail',name:'旧详情',prompt:'用户文案',n:3,size:'1024x1536',autoCrop2x2:false}, {id:'other',name:'无字段',prompt:'4张',n:2,size:'1536x864'}];
 let stored=JSON.stringify(old);const storage={getItem:()=>stored,setItem:(k,v)=>stored=v};const migrated=options.loadTemplates(storage);assert.equal(stored,JSON.stringify(old));
 assert.deepEqual(migrated.map(t=>t.generationMode),['crop_2x2','standard','standard']);for(let i=0;i<old.length;i++){assert.equal(migrated[i].prompt,old[i].prompt);assert.equal(migrated[i].size,old[i].size);assert.equal(migrated[i].name,old[i].name);}
 options.saveTemplates(storage,migrated);assert.equal(options.loadTemplates(storage)[0].extra,'保留');assert.equal(options.loadTemplates(storage)[2].n,2);
 assert.equal(options.normalizeTemplate({...old[0],generationMode:'standard'}).generationMode,'standard');
});
test('3456x2048 passes existing response budget; detail geometry preserves exact 9:16',()=>{
 assert.ok(rules.checkResultBudget('3456x2048',1).estimatedBytes<rules.MAX_RESPONSE_BYTES);
 assert.deepEqual(rules.detailGeometry(3456,2048,0),{column:1152,insetX:0,insetY:0,width:1152,height:2048});
 assert.deepEqual(rules.detailGeometry(3456,2048),{column:1152,insetX:18,insetY:32,width:1116,height:1984});
 const scaled=rules.detailGeometry(2592,1536);assert.equal(scaled.width*16,scaled.height*9);
 for(const args of [[3440,2048],[3456,2040],[0,2048],[3456,2048,-1],[3456,2048,.5]])assert.throws(()=>rules.detailGeometry(...args));
});
test('crop3x1 crops left, center, right at native size with safe inset or zero',async()=>{
 for(const [ratio,expected] of [[0,[[0,0,1152,2048,0,0,1152,2048],[1152,0,1152,2048,0,0,1152,2048],[2304,0,1152,2048,0,0,1152,2048]]],[1/64,[[18,32,1116,1984,0,0,1116,1984],[1170,32,1116,1984,0,0,1116,1984],[2322,32,1116,1984,0,0,1116,1984]]]]){
  const mock=runtime();const blobs=await api.crop3x1(new Blob([png]),undefined,mock.runtime,ratio);assert.equal(blobs.length,3);assert.deepEqual(mock.calls,expected);assert.ok(mock.closed());
 }
 const bad=runtime(3440,2048);await assert.rejects(api.crop3x1(new Blob([png]),undefined,bad.runtime),/3整除/);assert.equal(bad.calls.length,0);assert.ok(bad.closed());
 const distorted=runtime(3456,2000);await assert.rejects(api.crop3x1(new Blob([png]),undefined,distorted.runtime),/9:16/);assert.equal(distorted.calls.length,0);
});
test('both collage modes force n=1 in exactly one request and never send client strategy fields',async()=>{
 for(const [generationMode,size] of [['crop_2x2','2880x2880'],['crop_3x1','3456x2048']]){
  let calls=0;const result=await api.generate({base:'https://proxy.test/v1',key:'fake-token',text:'Prompt的3张4张不决定数量',n:10,size,generationMode},undefined,async(url,init)=>{calls++;const body=JSON.parse(init.body);assert.equal(body.n,1);assert.equal(body.size,size);assert.equal(body.generationMode,undefined);return Response.json({data:[{b64_json:png.toString('base64')}]});});assert.equal(calls,1);assert.equal(result.generationMode,generationMode);assert.equal(result.expectedCount,1);
  let originals=0;await assert.rejects(api.write({result,rid:'row',fid:'out',table:{setCellValue:()=>assert.fail('never clear')},base:{batchUploadFile:()=>assert.fail('cannot crop without Canvas')},onOriginal:()=>originals++}),/createImageBitmap/);assert.equal(originals,1);assert.equal(calls,1);
 }
});
test('standard supports n=1..10 without parsing prompt and invalid layouts never pay',async()=>{
 for(let n=1;n<=10;n++){
  let calls=0;const result=await api.generate({base:'https://proxy.test/v1',key:'fake-token',text:'输出3张4张',n,size:'1024x1024',generationMode:'standard',autoCrop2x2:true},undefined,async(url,init)=>{calls++;assert.equal(JSON.parse(init.body).n,n);return Response.json({data:Array.from({length:n},()=>({b64_json:png.toString('base64')}))});});assert.equal(calls,1);assert.equal(result.images.length,n);assert.equal(result.autoCrop2x2,false);
 }
 for(const change of [{size:'3440x2048'},{size:'3456x2000'},{size:'3456x2048',detailInsetRatio:.5},{size:'3456x2048',generationMode:'unknown'}])await assert.rejects(api.generate({base:'https://proxy.test/v1',key:'fake-token',text:'x',n:1,generationMode:'crop_3x1',...change},undefined,()=>assert.fail('must not pay')));
});
