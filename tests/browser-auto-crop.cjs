// Real browser Canvas, mocked SDK/OpenAI. No paid requests.
const {chromium}=require('playwright');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 let tinyPNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64');
 const server=http.createServer((req,res)=>{const name=['/image-api.js','/image-options.js','/server/image-rules.js'].includes(req.url)?req.url.slice(1):'index.html';res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(path.join(__dirname,'..',name)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});const page=await browser.newPage({acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let posts=0, mode='square', sheet;
  await page.addInitScript(()=>{
   window.writes=[];window.uploads=[];window.attachments=[{token:'old-result'}];window.failUpload=false;
   const table={id:'table',getName:async()=> '商品表',getFieldMetaList:async()=>[{id:'white',name:'白底图',type:17},{id:'main',name:'主图',type:17}],getCellValue:async fid=>fid==='white'?[{token:'product-token',name:'product.png',type:'image/png'}]:structuredClone(window.attachments),getCellAttachmentUrls:async()=>['https://attachment.test/product.png'],setCellValue:async(fid,rid,values)=>{window.writes.push([fid,rid,values]);window.attachments=structuredClone(values);},getActiveView:async()=>({getVisibleRecordIdList:async()=>['row']})};
   const mock={base:{getActiveTable:async()=>table,getSelection:async()=>({tableId:'table',recordId:'row'}),onSelectionChange:()=>{},batchUploadFile:async files=>{
    const sizes=[];for(const file of files){const bitmap=await window.nativeBitmap(file);sizes.push([bitmap.width,bitmap.height,file.name]);bitmap.close();}window.uploads.push(sizes);return window.failUpload?[]:files.map((_,i)=>'new-'+i);
   }}};
   Object.defineProperty(window,'__BITABLE__',{configurable:true,get:()=>mock,set:()=>{}});
  });
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.hostname==='127.0.0.1')return route.continue();
   if(url.hostname==='attachment.test')return route.fulfill({contentType:'image/png',body:tinyPNG});
   if(url.hostname!=='mock-api.test')throw Error('Unexpected external request: '+url.hostname);
   posts++;
   const form=await new Request(req.url(),{method:'POST',headers:{'Content-Type':req.headers()['content-type']},body:req.postDataBuffer()}).formData();
   assert.equal(form.getAll('image[]').length,5);assert.equal(form.getAll('image[]')[0].name,'reference-0.png');assert.equal(form.getAll('image[]')[4].name,'brand-3.png');
   assert.equal(form.get('prompt'),'现有Prompt：正方形、无边框无间隔的2×2商品拼版');
   if(mode==='normal'){assert.equal(form.get('n'),'4');return route.fulfill({json:{data:Array.from({length:4},()=>({b64_json:tinyPNG.toString('base64')}))}});}
   assert.equal(form.get('n'),'1');assert.equal(form.get('size'),'2880x2880');
   if(mode==='no-canvas')await page.evaluate(()=>{window.createImageBitmap=undefined;});
   const data=mode==='rectangle'?await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1024;c.height=1536;return c.toDataURL('image/png').split(',')[1];}):sheet;
   return route.fulfill({json:{data:[{b64_json:data}]}});
  });
  const url='http://127.0.0.1:'+server.address().port;
  const ready=async()=>{await page.locator('.chip').first().waitFor();await page.evaluate(()=>window.nativeBitmap=createImageBitmap);};
  await page.goto(url);await ready();await page.selectOption('#taskType','image');assert.equal(await page.isChecked('#autoCrop2x2'),false);
  // Generate a real simulated 2880px sheet with distinct quadrants, text and transparency.
  const checks=await page.evaluate(async()=>{
   const source=document.createElement('canvas');source.width=source.height=2880;const ctx=source.getContext('2d');
   const offsets=[[0,0],[1440,0],[0,1440],[1440,1440]],colors=['#ff0000','#00ff00','#0000ff','#ffff00'];
   offsets.forEach(([x,y],i)=>{ctx.fillStyle=colors[i];ctx.fillRect(x,y,1440,1440);ctx.fillStyle='#000000';ctx.font='36px sans-serif';ctx.fillText('LOGO 商品 '+i,x+30,y+90);});
   ctx.clearRect(1440,1440,20,20);
   const blob=await new Promise(r=>source.toBlob(r,'image/png'));const parts=await ImageAPI.crop2x2(blob);
   const matching=[],sizes=[];
   for(let i=0;i<parts.length;i++){
    const bitmap=await createImageBitmap(parts[i]);sizes.push([bitmap.width,bitmap.height]);const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const cctx=c.getContext('2d');cctx.drawImage(bitmap,0,0);bitmap.close();
    const actual=cctx.getImageData(0,0,1432,1432).data,expected=ctx.getImageData(offsets[i][0]+4,offsets[i][1]+4,1432,1432).data;
    matching.push(actual.every((value,j)=>value===expected[j]));
   }
   // A smaller real return proves split dimensions come from decoded pixels.
   const small=document.createElement('canvas');small.width=small.height=1600;const smallBlob=await new Promise(r=>small.toBlob(r,'image/png'));
   const smallParts=await ImageAPI.crop2x2(smallBlob);const smallBitmap=await createImageBitmap(smallParts[0]);const smallSize=[smallBitmap.width,smallBitmap.height];smallBitmap.close();
   return {sizes,matching,smallSize,sheet:source.toDataURL('image/png').split(',')[1]};
  });
  sheet=checks.sheet;
  tinyPNG=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=16;c.getContext('2d').fillRect(0,0,16,16);return c.toDataURL('image/png').split(',')[1];}),'base64');assert.deepEqual(checks.sizes,Array.from({length:4},()=>[1432,1432]));assert.deepEqual(checks.matching,[true,true,true,true]);assert.deepEqual(checks.smallSize,[792,792]);
  await page.selectOption('#imageCount','7');await page.check('#autoCrop2x2');assert.equal(await page.inputValue('#imageCount'),'1');assert.equal(await page.isDisabled('#imageCount'),true);
  await page.fill('#imageWidth','2880');await page.fill('#imageHeight','2880');await page.reload();await ready();assert.equal(await page.isChecked('#autoCrop2x2'),true);assert.equal(await page.inputValue('#imageCount'),'1');assert.equal(await page.isDisabled('#imageCount'),true);
  await page.uncheck('#autoCrop2x2');assert.equal(await page.inputValue('#imageCount'),'7');assert.equal(await page.isDisabled('#imageCount'),false);
  await page.check('#autoCrop2x2');await page.selectOption('#templateSelect','detail');assert.equal(await page.inputValue('#imageCount'),'1');assert.equal(await page.isDisabled('#imageCount'),true);
  await page.locator('.chip').filter({hasText:'白底图'}).click();await page.selectOption('#outputSel','main');await page.selectOption('#skipMode','overwrite');await page.fill('#apiBase','https://mock-api.test/v1');await page.fill('#apiKey','fake-proxy-token');await page.fill('#prompt','现有Prompt：正方形、无边框无间隔的2×2商品拼版');
  await page.click('#runBtn');assert.match(await page.locator('#imageError').textContent(),/正方形/);assert.equal(posts,0);
  await page.fill('#imageWidth','2880');await page.fill('#imageHeight','2880');
  for(let i=0;i<4;i++){await page.setInputFiles('#brandFile'+i,{name:'brand-'+i+'.png',mimeType:'image/png',buffer:tinyPNG});await page.waitForFunction(i=>!document.getElementById('brandFile'+i).disabled,i);}
  const finished=()=>page.waitForFunction(()=>!document.getElementById('runBtn').classList.contains('stop'));
  await page.click('#runBtn');await page.waitForFunction(()=>window.writes.length===1);await finished();assert.equal(posts,1);assert.deepEqual(await page.evaluate(()=>window.uploads[0].map(v=>v.slice(0,2))),Array.from({length:4},()=>[1432,1432]));
  const filenames=await page.evaluate(()=>window.uploads[0].map(v=>v[2]));filenames.forEach((name,i)=>assert.ok(name.startsWith('主图0'+(i+1)+'_')));
  assert.equal(await page.evaluate(()=>window.writes[0][2].length),5);assert.equal(await page.evaluate(()=>window.writes[0][2][0].token),'old-result');assert.ok((await page.locator('#log').textContent()).includes('已生成1张拼版图，成功裁切4张并回写飞书'));
  const downloadEvent=page.waitForEvent('download');await page.locator('#cropOriginalLinks a').first().click();const download=await downloadEvent;assert.ok(fs.readFileSync(await download.path()).equals(Buffer.from(sheet,'base64')));
  // Unchecking restores ordinary multi-image generation and appends all four new results.
  await page.uncheck('#autoCrop2x2');assert.equal(await page.inputValue('#imageCount'),'3');await page.selectOption('#imageCount','4');await page.selectOption('#imgSize','1024x1024');mode='normal';await page.click('#runBtn');await finished();assert.equal(await page.evaluate(()=>window.writes.length),2,(await page.locator('#log').textContent())+'; UI error: '+await page.locator('#imageError').textContent());assert.equal(posts,2);assert.equal(await page.evaluate(()=>window.attachments.length),9);
  // A non-square actual API return is rejected without overwriting or automatic paid retries.
  await page.check('#autoCrop2x2');await page.fill('#imageWidth','2880');await page.fill('#imageHeight','2880');mode='rectangle';await page.click('#runBtn');await page.waitForFunction(()=>document.getElementById('log').textContent.includes('不是正方形'));await finished();assert.equal(posts,3);assert.equal(await page.evaluate(()=>window.writes.length),2);assert.equal(await page.locator('#cropOriginalLinks a').count(),2);
  // Canvas disappears after preflight; original is still downloadable and no upload occurs.
  mode='no-canvas';await page.click('#runBtn');await page.waitForFunction(()=>document.getElementById('log').textContent.includes('不支持 createImageBitmap'));await finished();assert.equal(posts,4);assert.equal(await page.evaluate(()=>window.uploads.length),2);assert.equal(await page.locator('#cropOriginalLinks a').count(),3);await page.evaluate(()=>window.createImageBitmap=window.nativeBitmap);
  // Upload failure preserves all old attachments and leaves the paid original link.
  mode='square';await page.evaluate(()=>window.failUpload=true);await page.click('#runBtn');await page.waitForFunction(()=>document.getElementById('log').textContent.includes('未返回全部附件 token'));await finished();assert.equal(posts,5);assert.equal(await page.evaluate(()=>window.writes.length),2);assert.equal(await page.evaluate(()=>window.attachments.length),9);assert.equal(await page.locator('#cropOriginalLinks a').count(),4);
  await page.click('#clearCropOriginals');assert.equal(await page.locator('#cropOriginalLinks a').count(),0);assert.equal(await page.locator('#cropOriginals').isVisible(),false);assert.deepEqual(errors,[]);
  console.log('PASS crop browser: exact pixel/Logo/color/transparency preservation, 2880→4×1432 and 1600→4×792, ordered file upload, checkbox persistence/n=1, normal multi-image restore, recoverable failures, original download; no paid API');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
