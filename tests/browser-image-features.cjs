const {chromium}=require('playwright');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64');
 const server=http.createServer((req,res)=>{const name=['/image-api.js','/image-options.js','/server/image-rules.js'].includes(req.url)?req.url.slice(1):'index.html';res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(path.join(__dirname,'..',name)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let posts=0;
  await page.addInitScript(()=>{
   window.writes=[];window.uploaded=[];window.failUpload=false;
   const table={id:'table',getName:async()=> '商品表',getFieldMetaList:async()=>[{id:'white',name:'白底图',type:17},{id:'main',name:'主图',type:17}],getCellValue:async fid=>fid==='white'?[{token:'source-token',name:'product.png',type:'image/png'}]:[{token:'old-result'}],getCellAttachmentUrls:async()=>['https://attachment.test/product.png'],setCellValue:async(...args)=>window.writes.push(args),getRecordIdList:async()=>['row'],getActiveView:async()=>({getVisibleRecordIdList:async()=>['row']})};
   const mock={base:{getActiveTable:async()=>table,getSelection:async()=>({tableId:'table',recordId:'row'}),onSelectionChange:()=>{},batchUploadFile:async files=>{window.uploaded.push(files.map(f=>({size:f.size,type:f.type})));return window.failUpload?[]:files.map((_,i)=>'generated-'+i);}}};
   Object.defineProperty(window,'__BITABLE__',{configurable:true,get:()=>mock,set:()=>{}});
  });
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname==='127.0.0.1')return route.continue();
   if(u.hostname==='attachment.test')return route.fulfill({contentType:'image/png',body:png});
   if(u.hostname==='mock-api.test'){
    posts++;const req=route.request();assert.equal(u.pathname,'/v1/images/edits');
    const form=await new Request(req.url(),{method:'POST',headers:{'Content-Type':req.headers()['content-type']},body:req.postDataBuffer()}).formData();
    assert.equal(form.get('n'),'4');assert.equal(form.get('size'),'1024x1024');assert.equal(form.getAll('image[]').length,5);assert.equal(form.getAll('image[]')[0].name,'reference-0.png');assert.equal(form.getAll('image[]')[1].name,'brand-0.png');
    return route.fulfill({json:{data:Array.from({length:4},()=>({b64_json:png.toString('base64')}))}});
   }throw Error('Unexpected external request: '+u.hostname);
  });
  const url='http://127.0.0.1:'+server.address().port;
  const ready=async()=>{await page.locator('.chip').first().waitFor();await page.locator('#imageAdvanced').evaluate(el=>el.open=true);};
  await page.goto(url);await ready();await page.selectOption('#taskType','image');
  await page.selectOption('#templateSelect','main');assert.equal(await page.inputValue('#imageCount'),'1');assert.equal(await page.inputValue('#imageWidth'),'2880');assert.equal(await page.inputValue('#imageHeight'),'2880');
  await page.selectOption('#templateSelect','detail');assert.equal(await page.inputValue('#imageCount'),'1');assert.equal(await page.inputValue('#imageHeight'),'2048');
  await page.selectOption('#templateSelect','');await page.selectOption('#generationMode','standard');await page.fill('#templateName','测试模板');await page.fill('#prompt','保存的提示词');await page.selectOption('#imageCount','2');await page.fill('#imageWidth','1536');await page.fill('#imageHeight','864');await page.click('#saveTemplate');const savedId=await page.inputValue('#templateSelect');
  await page.fill('#templateName','重命名模板');await page.click('#renameTemplate');await page.reload();await ready();assert.equal(await page.locator('#templateSelect option:checked').textContent(),'重命名模板');
  await page.selectOption('#templateSelect','main');await page.selectOption('#templateSelect',savedId);assert.equal(await page.inputValue('#prompt'),'保存的提示词');assert.equal(await page.inputValue('#imageCount'),'2');assert.equal(await page.inputValue('#imageHeight'),'864');
  await page.click('#deleteTemplate');await page.reload();await ready();assert.equal(await page.locator('#templateSelect option').filter({hasText:'重命名模板'}).count(),0);
  for(let i=0;i<4;i++){await page.setInputFiles('#brandFile'+i,{name:'brand-'+i+'.png',mimeType:'image/png',buffer:png});await page.waitForFunction(i=>document.getElementById('brandPreview'+i).src.startsWith('blob:')&&!document.getElementById('brandFile'+i).disabled,i);}
  await page.setInputFiles('#brandFile0',{name:'replaced.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>!document.getElementById('brandFile0').disabled);
  await page.evaluate(()=>{window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('Mock quota','QuotaExceededError');};});
  await page.setInputFiles('#brandFile0',{name:'failed-replacement.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>!document.getElementById('brandFile0').disabled);assert.match(await page.locator('#imageError').textContent(),/旧图片未替换/);
  await page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalPut;});
  await page.click('#brandDelete1');await page.waitForFunction(()=>document.getElementById('brandPreview1').hidden&&!document.getElementById('brandDelete1').disabled);await page.reload();await ready();assert.equal(await page.locator('#brandPreview1').isVisible(),false);assert.equal(await page.locator('#brandPreview0').isVisible(),true);
  const filename=await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('ai-filler-brand-images',1);r.onsuccess=()=>{const q=r.result.transaction('slots').objectStore('slots').get(0);q.onsuccess=()=>resolve(q.result.name);q.onerror=reject;};}));assert.equal(filename,'replaced.png');
  await page.setInputFiles('#brandFile1',{name:'brand-again.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>!document.getElementById('brandFile1').disabled);
  await page.selectOption('#templateSelect','main');await page.selectOption('#generationMode','standard');await page.selectOption('#imageCount','4');await page.selectOption('#imgSize','1024x1024');await page.locator('.chip').filter({hasText:'白底图'}).click();await page.selectOption('#outputSel','main');await page.selectOption('#skipMode','overwrite');await page.fill('#apiBase','https://mock-api.test/v1');await page.fill('#apiKey','sk-DO-NOT-PERSIST');await page.locator('#apiKey').dispatchEvent('change');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ai-filler-cfg')).apiKey),'');await page.fill('#apiKey','fake-proxy-token');
  await page.fill('#imageWidth','1000');await page.click('#runBtn');assert.match(await page.locator('#imageError').textContent(),/16/);assert.equal(posts,0);
  await page.fill('#imageWidth','1024');await page.click('#runBtn');await page.waitForFunction(()=>window.writes.length===1);assert.equal(posts,1);assert.equal(await page.evaluate(()=>window.uploaded[0].length),4);assert.deepEqual(await page.evaluate(()=>window.writes[0][2].map(v=>v.token)),['old-result','generated-0','generated-1','generated-2','generated-3']);
  await page.waitForFunction(()=>!document.getElementById('runBtn').classList.contains('stop'));await page.evaluate(()=>window.failUpload=true);await page.click('#runBtn');await page.waitForFunction(()=>document.getElementById('log').textContent.includes('未返回全部附件'));assert.equal(posts,2);assert.equal(await page.evaluate(()=>window.writes.length),1);assert.deepEqual(errors,[]);
  console.log('PASS features browser: 4 persisted brand slots, replace/delete/preview, templates CRUD/reload, invalid size blocks call, one request n=4, append all images, failed upload preserves old cell; zero paid API calls');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
