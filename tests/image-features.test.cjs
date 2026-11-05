const {test}=require('node:test');const assert=require('node:assert/strict');
const rules=require('../server/image-rules.js');const options=require('../image-options.js');const api=require('../image-api.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64');
const config={base:'https://proxy.test/v1',key:'fake-proxy-token',size:'1024x1024',text:'保持产品与品牌风格',n:4};
test('official dimension boundaries and count are checked; result budget fails before payment',()=>{
 for(const size of ['1024x1024','1024x1536','1536x1024','1536x864','640x1024','1536x512','3840x2160','2160x3840'])assert.equal(rules.validate(size).size,size);
 for(const size of ['1025x1024','0x1024','1024x256','3856x1024','512x512','3840x2176','1e3x1024','auto'])assert.throws(()=>rules.validate(size));
 for(const n of [0,11,1.5,NaN])assert.throws(()=>rules.validate('1024x1024',n));
 assert.equal(rules.checkResultBudget('1024x1024',10).n,10);assert.throws(()=>rules.checkResultBudget('3840x2160',2),/64MiB/);
});
test('defaults and edited/renamed/deleted templates persist, including all deleted',()=>{
 const data=new Map();const storage={getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,v)};
 const templates=options.loadTemplates(storage);assert.deepEqual(templates.map(t=>[t.name,t.n,t.size]),[['主图模板',4,'1024x1024'],['详情页模板',3,'1024x1536']]);
 templates[0]={...templates[0],name:'品牌主图',prompt:'自定义 Prompt',n:2,size:'1536x864'};options.saveTemplates(storage,templates);
 assert.deepEqual(options.loadTemplates(storage),templates);options.saveTemplates(storage,[]);assert.deepEqual(options.loadTemplates(storage),[]);
 assert.throws(()=>options.saveTemplates(storage,[{name:'',size:'1024x1024',n:1}]));assert.deepEqual(options.loadTemplates(storage),[]);
});
test('product is first, four brand files follow; n images use exactly one paid request',async()=>{
 let posts=0;
 const brands=Array.from({length:4},()=>new Blob([png],{type:'image/png'}));
 const result=await api.generate({...config,imageUrls:['https://attachment.test/product'],brandImages:brands},undefined,async(url,init)=>{
  if(url.includes('attachment.test'))return new Response(png,{headers:{'Content-Type':'image/png'}});
  posts++;assert.ok(url.endsWith('/images/edits'));assert.equal(init.body.get('n'),'4');
  const images=init.body.getAll('image[]');assert.equal(images.length,5);assert.equal(images[0].name,'reference-0.png');assert.equal(images[1].name,'brand-0.png');assert.equal(images[4].name,'brand-3.png');
  return Response.json({data:Array.from({length:4},()=>({b64_json:png.toString('base64')}))});
 });assert.equal(posts,1);assert.equal(result.images.length,4);assert.equal(result.expectedCount,4);
 let uploads=0,writes=0;
 await api.write({result,fid:'main',rid:'row',append:true,base:{batchUploadFile:async files=>{uploads++;assert.equal(files.length,4);return files.map((_,i)=>'new-'+i);}},table:{getCellValue:async()=>[{token:'old-result'}],setCellValue:async(fid,rid,values)=>{writes++;assert.deepEqual(values.map(v=>v.token),['old-result','new-0','new-1','new-2','new-3']);}}});
 assert.equal(uploads,1);assert.equal(writes,1);assert.equal(posts,1);
});
test('partial upstream result is retained; missing upload token never overwrites old attachments',async()=>{
 let calls=0;
 const result=await api.generate(config,undefined,async()=>{calls++;return Response.json({data:[{b64_json:png.toString('base64')},{invalid:true}]});});
 assert.equal(result.images.length,1);assert.equal(result.expectedCount,4);assert.equal(calls,1);
 await assert.rejects(api.write({result:{images:[{b64:png.toString('base64')},{b64:png.toString('base64')}]},fid:'main',rid:'row',append:true,base:{batchUploadFile:async()=>['only-one']},table:{setCellValue:()=>assert.fail('must not overwrite')}}),/全部附件 token/);
});
test('invalid dimensions, result budget and official keys cause zero requests',async()=>{
 const reject=async c=>assert.rejects(api.generate({...config,...c},undefined,()=>assert.fail('must not call API')));
 await reject({size:'1025x1024'});await reject({n:11});await reject({size:'3840x2160',n:2});await reject({key:'sk-fake-official-key'});
});
test('multi-image size failures show safe Chinese guidance without echoing upstream body',async()=>{
 let calls=0;
 await assert.rejects(api.generate(config,undefined,async()=>{calls++;return Response.json({error:{code:'RESULT_TOO_LARGE',message:'SENSITIVE-SECRET'}},{status:502});}),e=>e.message.includes('减少数量')&&!e.message.includes('SENSITIVE-SECRET'));
 assert.equal(calls,1);
});
test('official key detection covers whitespace and pasted Bearer prefix; corrupted templates fail safely',()=>{
 assert.equal(rules.isOfficialKey(' sk-proj-fake '),true);assert.equal(rules.isOfficialKey('Bearer sk-fake'),true);assert.equal(rules.isOfficialKey('independent-proxy-token'),false);
 assert.throws(()=>options.loadTemplates({getItem:()=>'{"not":"an array"}'}),/模板/);
});
test('template quota failure keeps previously saved data',()=>{
 let stored=JSON.stringify(options.defaults());const original=stored;
 const storage={getItem:()=>stored,setItem:()=>{throw new DOMException('quota','QuotaExceededError');}};
 const templates=options.loadTemplates(storage);templates[0].name='未保存名称';assert.throws(()=>options.saveTemplates(storage,templates),{name:'QuotaExceededError'});assert.equal(stored,original);
});
