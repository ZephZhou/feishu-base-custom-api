// Real Canvas + generated fixtures only. No OpenAI/Feishu/network calls.
const {chromium}=require('playwright');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();await page.route('http**/*',()=>assert.fail('No network permitted'));
  await page.addScriptTag({path:path.resolve(__dirname,'../server/image-rules.js')});await page.addScriptTag({path:path.resolve(__dirname,'../image-api.js')});
  const results=await page.evaluate(async()=>{
   const reports={};
   for(const kind of ['black-frame','opaque-white','transparent','semi-transparent']){
    const size=kind==='black-frame'?2880:256,side=size/2;
    const c=document.createElement('canvas');c.width=c.height=size;const ctx=c.getContext('2d');
    const positions=[[0,0],[side,0],[0,side],[side,side]],colors=['#ff0000','#00ff00','#0000ff','#ffff00'];
    positions.forEach(([x,y],i)=>{
     ctx.fillStyle=kind==='opaque-white'?'white':colors[i];ctx.fillRect(x,y,side,side);
     const edge=kind==='black-frame'?16:28;
     const edges=[[x,y,side,edge],[x,y,edge,side],[x+side-edge,y,edge,side],[x,y+side-edge,side,edge]];
     if(kind==='black-frame'){
      ctx.fillStyle='black';edges.forEach(rect=>ctx.fillRect(...rect));
      ctx.fillStyle='white';ctx.fillRect(x+16,y+20,3,9);ctx.font='32px sans-serif';ctx.fillText('LOGO '+i,x+32,y+70);
     }
     if(kind==='transparent'||kind==='semi-transparent'){
      edges.forEach(rect=>ctx.clearRect(...rect));
      if(kind==='semi-transparent'){ctx.fillStyle='rgba(255,0,0,0.5)';edges.forEach(rect=>ctx.fillRect(...rect));}
     }
    });
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));reports[kind]={};
    // inset=0 reproduces the prior 1:1 crop and PNG export path for root-cause control.
    for(const inset of [0,4,24]){
     const parts=await ImageAPI.crop2x2(blob,undefined,globalThis,inset),outSide=side-2*inset;
     const exact=[],blackEdges=[],alphaEdges=[],dimensions=[];
     for(let i=0;i<4;i++){
      const bitmap=await createImageBitmap(parts[i]);dimensions.push([bitmap.width,bitmap.height]);
      const out=document.createElement('canvas');out.width=bitmap.width;out.height=bitmap.height;const o=out.getContext('2d');o.drawImage(bitmap,0,0);bitmap.close();
      const pixels=o.getImageData(0,0,outSide,outSide).data;
      const source=ctx.getImageData(positions[i][0]+inset,positions[i][1]+inset,outSide,outSide).data;
      exact.push(pixels.every((value,j)=>value===source[j]));let black=0,transparent=0,semi=0;
      for(let y=0;y<outSide;y++)for(let x=0;x<outSide;x++)if(!x||!y||x===outSide-1||y===outSide-1){
       const p=(y*outSide+x)*4,alpha=pixels[p+3];
       if(alpha===255&&pixels[p]===0&&pixels[p+1]===0&&pixels[p+2]===0)black++;
       if(alpha===0)transparent++;if(alpha>0&&alpha<255)semi++;
      }
      blackEdges.push(black);alphaEdges.push({transparent,semi});
     }
     reports[kind][inset]={exact,blackEdges,alphaEdges,dimensions};
    }
   }
   return reports;
  });
  for(const report of Object.values(results))for(const test of Object.values(report))assert.deepEqual(test.exact,[true,true,true,true]);
  const bordered=results['black-frame'];assert.ok(bordered[0].blackEdges.every(n=>n>0));assert.ok(bordered[4].blackEdges.every(n=>n>0));assert.deepEqual(bordered[24].blackEdges,[0,0,0,0]);assert.deepEqual(bordered[24].dimensions,Array.from({length:4},()=>[1392,1392]));
  for(const kind of ['opaque-white','transparent','semi-transparent'])for(const inset of [0,4,24])assert.deepEqual(results[kind][inset].blackEdges,[0,0,0,0]);
  for(const inset of [0,4,24]){
   assert.ok(results.transparent[inset].alphaEdges.every(n=>n.transparent>0&&n.semi===0));
   assert.ok(results['semi-transparent'][inset].alphaEdges.every(n=>n.semi>0&&n.transparent===0));
  }
  console.log('PASS black-border diagnostics: original and inset Canvas/PNG paths preserve source RGBA, transparent/semi-transparent edges never become opaque black; per-quadrant 24px inset removes all simulated outer AND center 16px frames that remain at 4px; 4×1392, no resize or API calls');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
