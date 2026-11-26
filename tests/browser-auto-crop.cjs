// Real browser Canvas, mocked SDK/OpenAI. No paid requests.
const {chromium}=require('playwright');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 let tinyPNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64');
 const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;const name=['/image-api.js','/image-options.js','/image-recovery.js','/server/image-rules.js'].includes(pathname)?pathname.slice(1):'index.html';res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(path.join(__dirname,'..',name)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});const page=await browser.newPage({acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let posts=0, mode='square', sheet;
  await page.addInitScript(()=>{
   window.writes=[];window.uploads=[];window.selectedRow='row';window.activeTableId='table';
   window.attachments=JSON.parse(sessionStorage.getItem('mock-attachments')) || [{token:'old-result'}];
   const products=[0,1,2].map(i=>({token:`product-${i}`,name:`product-${i}.png`,type:'image/png'}));
   const table={id:'table',getName:async()=> '商品表',getFieldMetaList:async()=>[{id:'white',name:'白底图',type:19},{id:'main',name:'主图',type:17},{id:'other',name:'其他附件',type:17},{id:'sku',name:'SKU',type:1}],
    getCellValue:async (fid,rid)=>fid==='white'?{type:17,value:products}:fid==='main'&&rid==='row'?structuredClone(window.attachments):[],
    getCellString:async()=> 'NOW-04603',
    getCellAttachmentUrls:async (tokens,fid,rid)=>{
     if(fid!=='white'||rid!=='row'||tokens.join()!=='product-0,product-1,product-2')throw Error('Wrong source context');
     return tokens.map(t=>`https://attachment.test/${t}.png`);
    },
    setCellValue:async(fid,rid,values)=>{
     if(fid!=='main'||rid!=='row')throw Error('Wrong write destination');
     if(window.failWrite==='false')return false;
     window.writes.push([fid,rid,values]);window.attachments=structuredClone(values);
     sessionStorage.setItem('mock-attachments',JSON.stringify(values));
     if(window.failWrite==='afterCommit')throw {code:'D3001',msg:'任务异常'};
     return true;
    },getActiveView:async()=>({getVisibleRecordIdList:async()=>['row']})};
   const mock={base:{getActiveTable:async()=>({...table,id:window.activeTableId}),getSelection:async()=>({tableId:window.activeTableId,recordId:window.selectedRow}),onSelectionChange:()=>{},batchUploadFile:async files=>{
    const sizes=[];for(const file of files){const bitmap=await window.nativeBitmap(file);sizes.push([bitmap.width,bitmap.height,file.name]);bitmap.close();}window.uploads.push(sizes);
    if(window.failUpload)throw {code:'D3001',msg:'任务异常'};
    return files.map((_,i)=>`new-${window.uploads.length}-${i}`);
   }}};
   Object.defineProperty(window,'__BITABLE__',{configurable:true,get:()=>mock,set:()=>{}});
  });
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.hostname==='127.0.0.1')return route.continue();
   if(url.hostname==='attachment.test')return route.fulfill({contentType:'image/png',body:tinyPNG});
   if(url.hostname!=='mock-api.test')throw Error('Unexpected external request: '+url.hostname);
   posts++;
   const form=await new Request(req.url(),{method:'POST',headers:{'Content-Type':req.headers()['content-type']},body:req.postDataBuffer()}).formData();
   assert.deepEqual(form.getAll('image[]').map(file=>file.name),['reference-0.png','reference-1.png','reference-2.png','brand-0.png','brand-1.png','brand-2.png']);
   assert.equal(form.get('prompt'),'现有Prompt：正方形、无边框无间隔的2×2商品拼版');
   if(mode==='normal'){assert.equal(form.get('n'),'4');return route.fulfill({json:{data:Array.from({length:4},()=>({b64_json:tinyPNG.toString('base64')}))}});}
   assert.equal(form.get('n'),'1');assert.equal(form.get('size'),'2880x2880');
   if(mode==='export-fails')await page.evaluate(()=>{
    window.createImageBitmap=async()=>{throw Error('Mock bitmap rejection');};
    window.originalToBlob=HTMLCanvasElement.prototype.toBlob;
    let calls=0;
    HTMLCanvasElement.prototype.toBlob=function(callback,...args){
     if(++calls===2)return callback(null);
     return window.originalToBlob.call(this,callback,...args);
    };
   });
   const data=mode==='rectangle'?await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1024;c.height=1536;return c.toDataURL('image/png').split(',')[1];}):sheet;
   return route.fulfill({json:{data:[{b64_json:data}]}});
  });
  const url='http://127.0.0.1:'+server.address().port;
  const ready=async()=>{await page.locator('.chip').first().waitFor();await page.evaluate(()=>{window.nativeBitmap=createImageBitmap;document.getElementById('imageAdvanced').open=true;});};
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
    const actual=cctx.getImageData(0,0,1392,1392).data,expected=ctx.getImageData(offsets[i][0]+24,offsets[i][1]+24,1392,1392).data;
    matching.push(actual.every((value,j)=>value===expected[j]));
   }
   // A smaller real return proves split dimensions come from decoded pixels.
   const small=document.createElement('canvas');small.width=small.height=1600;const smallBlob=await new Promise(r=>small.toBlob(r,'image/png'));
   const smallParts=await ImageAPI.crop2x2(smallBlob);const smallBitmap=await createImageBitmap(smallParts[0]);const smallSize=[smallBitmap.width,smallBitmap.height];smallBitmap.close();
   return {sizes,matching,smallSize,sheet:source.toDataURL('image/png').split(',')[1]};
  });
  sheet=checks.sheet;
  tinyPNG=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=16;c.getContext('2d').fillRect(0,0,16,16);return c.toDataURL('image/png').split(',')[1];}),'base64');assert.deepEqual(checks.sizes,Array.from({length:4},()=>[1392,1392]));assert.deepEqual(checks.matching,[true,true,true,true]);assert.deepEqual(checks.smallSize,[752,752]);
  await page.selectOption('#imageCount','7');await page.selectOption('#generationMode','crop_2x2');assert.equal(await page.inputValue('#imageCount'),'1');assert.equal(await page.isDisabled('#imageCount'),true);
  await page.fill('#imageWidth','2880');await page.fill('#imageHeight','2880');await page.reload();await ready();assert.equal(await page.isChecked('#autoCrop2x2'),true);assert.equal(await page.inputValue('#imageCount'),'1');assert.equal(await page.isDisabled('#imageCount'),true);
  await page.selectOption('#generationMode','standard');assert.equal(await page.inputValue('#imageCount'),'7');assert.equal(await page.isDisabled('#imageCount'),false);
  await page.selectOption('#generationMode','crop_2x2');await page.selectOption('#templateSelect','detail');await page.selectOption('#generationMode','crop_2x2');assert.equal(await page.inputValue('#imageCount'),'1');assert.equal(await page.isDisabled('#imageCount'),true);
  await page.locator('.chip').filter({hasText:'白底图'}).click();await page.selectOption('#outputSel','main');await page.selectOption('#skipMode','overwrite');await page.fill('#apiBase','https://mock-api.test/v1');await page.fill('#apiKey','fake-proxy-token');await page.fill('#prompt','现有Prompt：正方形、无边框无间隔的2×2商品拼版');
  await page.click('#runBtn');assert.match(await page.locator('#imageError').textContent(),/正方形/);assert.equal(posts,0);
  await page.selectOption('#templateSelect','main');assert.ok(await page.isDisabled('#generationMode'));
  await page.fill('#prompt','现有Prompt：正方形、无边框无间隔的2×2商品拼版');await page.selectOption('#outputSel','main');await page.click('#saveTemplate');
  await page.evaluate(()=>{
   const cfg=JSON.parse(localStorage.getItem('ai-filler-cfg'));
   Object.assign(cfg,{generationMode:'standard',autoCrop2x2:false,imageCount:'4',imageWidth:'1024',imageHeight:'1536'});
   localStorage.setItem('ai-filler-cfg',JSON.stringify(cfg));
  });
  await page.reload();await ready();assert.equal(await page.inputValue('#generationMode'),'crop_2x2');assert.equal(await page.inputValue('#imageHeight'),'2880');
  await page.selectOption('#skipMode','overwrite');
  for(let i=0;i<3;i++){await page.setInputFiles('#brandFile'+i,{name:'brand-'+i+'.png',mimeType:'image/png',buffer:tinyPNG});await page.waitForFunction(i=>!document.getElementById('brandFile'+i).disabled,i);}
  const finished=()=>page.waitForFunction(()=>!document.getElementById('runBtn').classList.contains('stop'));
  const originals=page.getByRole('link',{name:'下载拼版原图',exact:true});
  await page.evaluate(()=>{
   window.originalCreateUrl=URL.createObjectURL;
   URL.createObjectURL=()=>{throw Error('Mock download URL failure');};
  });
  await page.click('#runBtn');await page.waitForFunction(()=>window.writes.length===1);await finished();assert.equal(posts,1);assert.deepEqual(await page.evaluate(()=>window.uploads[0].map(v=>v.slice(0,2))),Array.from({length:4},()=>[1392,1392]));
  const filenames=await page.evaluate(()=>window.uploads[0].map(v=>v[2]));filenames.forEach((name,i)=>assert.ok(name.startsWith('主图0'+(i+1)+'_')));
  assert.equal(await page.evaluate(()=>window.writes[0][2].length),5);assert.equal(await page.evaluate(()=>window.writes[0][2][0].token),'old-result');assert.ok((await page.locator('#log').textContent()).includes('API生成1张，裁切4张，上传4张'));
  const log=await page.locator('#log').textContent();
  assert.match(log,/SKU NOW-04603；商品原图 3 张.*固定品牌图 3 张/);
  assert.match(log,/当前模板 主图模板 · 生成策略 crop_2x2[\s\S]*response_complete[\s\S]*original_image · 2880×2880 · image\/png · \d+ 字节[\s\S]*crop_start[\s\S]*第 4 张已裁切 · 1392×1392[\s\S]*crop_complete[\s\S]*upload_start[\s\S]*upload_complete · 上传成功 4 张[\s\S]*write_start[\s\S]*write_complete/);
  await originals.first().click();assert.match(await page.locator('#log').textContent(),/无法创建图片下载链接/);
  await page.evaluate(()=>{URL.createObjectURL=window.originalCreateUrl;});
  const downloadEvent=page.waitForEvent('download');await originals.first().click();const download=await downloadEvent;assert.ok(fs.readFileSync(await download.path()).equals(Buffer.from(sheet,'base64')));
  // Unchecking restores ordinary multi-image generation and appends all four new results.
  await page.selectOption('#templateSelect','');await page.selectOption('#generationMode','standard');await page.selectOption('#imageCount','4');await page.selectOption('#imgSize','1024x1024');mode='normal';await page.click('#runBtn');await finished();assert.equal(await page.evaluate(()=>window.writes.length),2,(await page.locator('#log').textContent())+'; UI error: '+await page.locator('#imageError').textContent());assert.equal(posts,2);assert.equal(await page.evaluate(()=>window.attachments.length),9);
  // A non-square actual API return is rejected without overwriting or automatic paid retries.
  await page.selectOption('#templateSelect','main');mode='rectangle';await page.click('#runBtn');await page.waitForFunction(()=>document.getElementById('log').textContent.includes('不是正方形'));await finished();assert.equal(posts,3);assert.equal(await page.evaluate(()=>window.writes.length),2);assert.equal(await originals.count(),2);
  // The browser's Image fallback decodes the collage; retain the first crop when the second export fails.
  mode='export-fails';await page.click('#runBtn');await finished();assert.match(await page.locator('#imageError').textContent(),/crop 失败 · Canvas 裁切导出失败/);
  assert.equal(posts,4);assert.equal(await page.evaluate(()=>window.uploads.length),2);assert.equal(await originals.count(),3);
  const partialJob=page.locator('.crop-recovery-item').filter({has:page.getByRole('link',{name:'下载裁切图 1',exact:true})});
  await page.reload();await ready();assert.equal(await partialJob.count(),1);
  const partDownload=page.waitForEvent('download');await partialJob.getByRole('link',{name:'下载裁切图 1',exact:true}).click();
  const part=fs.readFileSync(await (await partDownload).path());assert.equal(part.readUInt32BE(16),1392);assert.equal(part.readUInt32BE(20),1392);
  const retry=partialJob.getByRole('button',{name:'重新上传并回写飞书'});
  assert.ok(await retry.isDisabled());
  await partialJob.getByRole('button',{name:'重新裁切'}).click();
  await partialJob.getByRole('link',{name:'下载裁切图 4',exact:true}).waitFor();
  await page.selectOption('#outputSel','other');await page.evaluate(()=>{window.selectedRow='another-row';window.activeTableId='other-table';});
  await retry.click();await page.waitForFunction(()=>document.querySelector('#imageError').textContent.includes('原数据表'));
  assert.equal(await page.evaluate(()=>window.uploads.length),0);
  await page.evaluate(()=>{window.activeTableId='table';window.failUpload=true;});
  await retry.click();await page.waitForFunction(()=>document.querySelector('#imageError').textContent.includes('batchUploadFile 失败 · 错误码 D3001'));
  assert.equal(await page.evaluate(()=>window.attachments.length),9);
  await page.evaluate(()=>{window.failUpload=false;window.failWrite='false';});
  await retry.click();await page.waitForFunction(()=>document.querySelector('#imageError').textContent.includes('setCellValue 失败 · 飞书 SDK 返回 false'));
  assert.equal(await page.evaluate(()=>window.attachments.length),9);
  await page.evaluate(()=>{window.failWrite='afterCommit';});
  await retry.click();await page.waitForFunction(()=>document.querySelector('#imageError').textContent.includes('setCellValue 失败 · 错误码 D3001'));
  assert.deepEqual(await page.evaluate(()=>window.writes[0].slice(0,2)),['main','row']);
  await retry.click();await page.waitForFunction(()=>document.querySelector('#cropOriginalLinks').textContent.includes('已回写'));
  assert.deepEqual(await page.evaluate(()=>window.uploads.map(files=>files.length)),[4,4,4]);
  assert.equal(await page.evaluate(()=>window.writes.length),1);
  assert.equal(await page.evaluate(()=>window.attachments.length),13);
  assert.equal(posts,4);
  await page.click('#clearCropOriginals');assert.equal(await originals.count(),1);assert.deepEqual(errors,[]);
  console.log('PASS crop browser: 3+3 references, exact 24px inset, four uploads, original and partial downloads after reload, local recrop, staged D3001, false write, resolved write with no duplicates or extra generation');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
