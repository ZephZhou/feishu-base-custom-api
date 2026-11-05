const {test}=require('node:test'); const assert=require('node:assert/strict');
const {createProxy}=require('../server/image-proxy.cjs');
test('proxy restricts origin/auth/path/body, replaces token, and forwards only to OpenAI',async()=>{
 let calls=0;
 const server=createProxy({apiKey:'fake-upstream-key',token:'x'.repeat(32),origins:['https://shop.github.io'],maxBytes:4096,fetcher:async(url,init)=>{
  calls++; assert.equal(url,'https://api.openai.com/v1/images/generations');assert.equal(init.headers.Authorization,'Bearer fake-upstream-key');assert.equal(JSON.parse(init.body).n,1);return Response.json({data:[{b64_json:'mock-image'}]});
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 const headers={Origin:'https://shop.github.io',Authorization:'Bearer '+'x'.repeat(32),'Content-Type':'application/json'};
 const data={model:'gpt-image-2',prompt:'场景',size:'1024x1024',n:1,output_format:'png'};
 try {
  assert.equal((await fetch(url+'/v1/images/generations',{method:'OPTIONS',headers})).status,204);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify(data)})).status,403);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST',headers:{...headers,Authorization:'Bearer bad'},body:JSON.stringify(data)})).status,401);
  assert.equal((await fetch(url+'/v1/anything',{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST',headers,body:JSON.stringify({...data,images:['https://private.test']})})).status,400);
  assert.equal((await fetch(url+'/v1/images/edits',{method:'POST',headers,body:'{}'})).status,415);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST',headers,body:'x'.repeat(4097)})).status,413);
  assert.equal(calls,0);
  const r=await fetch(url+'/v1/images/generations',{method:'POST',headers,body:JSON.stringify(data)});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'https://shop.github.io');assert.equal((await r.json()).data[0].b64_json,'mock-image');assert.equal(calls,1);
 } finally {await new Promise(r=>server.close(r));}
});
test('multipart edits pass files and upstream failures are sanitized without retry',async()=>{
 let calls=0;
 const server=createProxy({apiKey:'fake-key',token:'y'.repeat(32),origins:['https://shop.github.io'],fetcher:async(url,init)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/images/edits');assert.ok(init.body instanceof FormData);assert.equal(init.body.getAll('image[]').length,1);assert.equal(init.headers['Content-Type'],undefined);return Response.json({error:{message:'sensitive-upstream-error'}},{status:400});
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const body=new FormData();for(const [k,v] of Object.entries({model:'gpt-image-2',prompt:'场景',size:'1024x1024',n:'1',output_format:'png'}))body.append(k,v);body.append('image[]',new Blob(['mock-file'],{type:'image/png'}),'reference.png');
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/images/edits',{method:'POST',headers:{Origin:'https://shop.github.io',Authorization:'Bearer '+'y'.repeat(32)},body});assert.equal(r.status,400);assert.ok(!(await r.text()).includes('sensitive'));assert.equal(calls,1);
 } finally {await new Promise(r=>server.close(r));}
});

test('health is exact, public, secret-free and never calls upstream', async()=>{
 const server=createProxy({apiKey:'fake-health-key',token:'h'.repeat(32),origins:['https://shop.github.io'],fetcher:()=>assert.fail('health must not call OpenAI')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 try {
  for(const headers of [{},{Origin:'https://evil.test'}]) {
   const r=await fetch(url+'/health',{headers});assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'ok'});assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  assert.equal((await fetch(url+'/health?secret=anything')).status,403);
  assert.equal((await fetch(url+'/health',{method:'POST'})).status,403);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST'})).status,403);
 }finally{await new Promise(r=>server.close(r));}
});

test('Render listens on all interfaces and PORT; local default remains loopback',async()=>{
 const {listenOptions,startProxy,UPLOAD_TIMEOUT_MS,GENERATION_TIMEOUT_MS}=require('../server/image-proxy.cjs');
 assert.deepEqual(listenOptions({}),{port:8787,host:'127.0.0.1'});
 assert.deepEqual(listenOptions({RENDER:'true',PORT:'10000'}),{port:10000,host:'0.0.0.0'});
 assert.deepEqual(listenOptions({PORT:'9000'}),{port:9000,host:'127.0.0.1'});
 assert.throws(()=>listenOptions({PORT:'invalid'}),/PORT/);
 assert.throws(()=>listenOptions({PORT:'65536'}),/PORT/);
 for(const render of [undefined,'true']) {
  const server=startProxy({RENDER:render,PORT:'0',OPENAI_API_KEY:'fake-start-key',PROXY_TOKEN:'s'.repeat(32),ALLOWED_ORIGINS:'https://shop.github.io'});
  await new Promise(r=>server.once('listening',r));
  try {
   assert.equal(server.address().address,render?'0.0.0.0':'127.0.0.1');assert.ok(server.address().port>0);
   assert.equal(server.requestTimeout,UPLOAD_TIMEOUT_MS);assert.equal(server.requestTimeout,300000);assert.equal(GENERATION_TIMEOUT_MS,600000);assert.equal(server.headersTimeout,60000);assert.equal(server.timeout,0);
   assert.deepEqual(await (await fetch('http://127.0.0.1:'+server.address().port+'/health')).json(),{status:'ok'});
  }finally{await new Promise(r=>server.close(r));}
 }
});

test('generation deadline returns sanitized 504 without retry',async()=>{
 let calls=0;
 const server=createProxy({apiKey:'fake-timeout-key',token:'t'.repeat(32),origins:['https://shop.github.io'],generationTimeoutMs:30,fetcher:async(url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('secret-error','AbortError')),{once:true}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/images/generations',{method:'POST',headers:{Origin:'https://shop.github.io',Authorization:'Bearer '+'t'.repeat(32),'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:'场景',size:'1024x1024',n:1,output_format:'png'})});
  assert.equal(r.status,504);assert.ok(!(await r.text()).includes('secret-error'));assert.equal(calls,1);
 }finally{await new Promise(r=>server.close(r));}
});

test('native HTTPS transport serializes multipart and preserves abort signal without real requests',async()=>{
 const {EventEmitter}=require('node:events');const {openAIRequest}=require('../server/image-proxy.cjs');
 const controller=new AbortController();const form=new FormData();form.append('prompt','电商场景');form.append('image[]',new Blob(['fake-image'],{type:'image/png'}),'reference.png');
 let sent;
 const r=await openAIRequest('https://api.openai.com/v1/images/edits',{headers:{Authorization:'Bearer fake-key'},body:form,signal:controller.signal},(url,options,callback)=>{
  assert.equal(url,'https://api.openai.com/v1/images/edits');assert.equal(options.signal,controller.signal);assert.match(options.headers['content-type'],/^multipart\/form-data; boundary=/);
  const req=new EventEmitter();req.end=bytes=>{sent=bytes.toString();const response=new EventEmitter();response.statusCode=200;callback(response);response.emit('data',Buffer.from('{"data":[{"b64_json":"mock"}]}'));response.emit('end');};return req;
 });
 assert.ok(sent.includes('name="image[]"'));assert.ok(sent.includes('fake-image'));assert.equal((await r.json()).data[0].b64_json,'mock');
 controller.abort();await assert.rejects(openAIRequest('https://api.openai.com/v1/images/generations',{headers:{},body:'{}',signal:controller.signal},()=>assert.fail('aborted request must not be sent')),{name:'AbortError'});
});

test('documented npm start command runs in server directory with Render environment', async()=>{
 const {spawn}=require('node:child_process');const path=require('node:path');
 const child=spawn('npm',['start'],{cwd:path.join(__dirname,'../server'),detached:true,env:{...process.env,RENDER:'true',PORT:'0',OPENAI_API_KEY:'fake-cli-key',PROXY_TOKEN:'c'.repeat(32),ALLOWED_ORIGINS:'https://shop.github.io'},stdio:['ignore','pipe','pipe']});
 try {
  const port=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('npm start readiness timeout')),10000);let out='';
   child.stdout.on('data',chunk=>{out+=chunk.toString();const match=out.match(/listening on 0\.0\.0\.0:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
   child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(Error('npm start exited '+code));});
  });
  const r=await fetch('http://127.0.0.1:'+port+'/health');assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'ok'});
 }finally{process.kill(-child.pid,'SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}
});

test('request IDs correlate safe stage logs and CORS; failures do not log secrets or bodies',async()=>{
 const logs=[];const id='12345678-1234-1234-1234-123456789abc';let calls=0;
 const server=createProxy({apiKey:'SENSITIVE-KEY',token:'z'.repeat(32),origins:['https://shop.github.io'],logger:r=>logs.push(r),fetcher:async(url,{trace})=>{calls++;trace('upstream_dns');throw Object.assign(Error('SENSITIVE-KEY SENSITIVE-PROMPT'),{code:'ENOTFOUND'});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 try {
  const headers={Origin:'https://shop.github.io',Authorization:'Bearer '+'z'.repeat(32),'X-Request-ID':id,'Content-Type':'application/json'};
  const preflight=await fetch(url+'/v1/images/edits',{method:'OPTIONS',headers});assert.match(preflight.headers.get('access-control-allow-headers'),/X-Request-ID/);
  logs.length=0;
  const r=await fetch(url+'/v1/images/generations',{method:'POST',headers,body:JSON.stringify({model:'gpt-image-2',prompt:'SENSITIVE-PROMPT',size:'1024x1024',n:1,output_format:'png'})});
  assert.equal(r.status,502);assert.equal(r.headers.get('x-request-id'),id);assert.equal((await r.json()).request_id,id);assert.match(r.headers.get('access-control-expose-headers'),/X-Request-ID/);
  assert.equal(calls,1);assert.ok(logs.some(r=>r.stage==='upload_received'&&r.bytes>0));
  assert.ok(logs.some(r=>r.stage==='request_failed'&&r.failed_stage==='upstream_dns'&&r.error_code==='ENOTFOUND'));
  assert.ok(logs.every(r=>r.request_id===id&&r.elapsed_ms>=0));
  const text=JSON.stringify(logs);for(const secret of ['SENSITIVE-KEY','SENSITIVE-PROMPT','z'.repeat(32)])assert.ok(!text.includes(secret));
 }finally{await new Promise(r=>server.close(r));}
});

test('DNS/TCP/TLS connection stall has its own deadline, without retry',async()=>{
 const {EventEmitter}=require('node:events');const {openAIRequest}=require('../server/image-proxy.cjs');let calls=0;
 await assert.rejects(openAIRequest('https://api.openai.com/v1/images/generations',{headers:{},body:'{}',signal:new AbortController().signal,connectTimeoutMs:10},()=>{calls++;const req=new EventEmitter();req.end=()=>{};req.destroy=err=>req.emit('error',err);return req;}),{code:'ETIMEDOUT'});assert.equal(calls,1);
});

test('native transport reports ordered connection stages and rejects truncated response',async()=>{
 const {EventEmitter}=require('node:events');const {openAIRequest}=require('../server/image-proxy.cjs');
 const stages=[];
 await assert.rejects(openAIRequest('https://api.openai.com/v1/images/generations',{headers:{},body:'{}',signal:new AbortController().signal,trace:s=>stages.push(s)},(url,options,callback)=>{
  const req=new EventEmitter();req.end=bytes=>{
   assert.equal(options.headers['content-length'],String(bytes.length));
   const socket=new EventEmitter();req.emit('socket',socket);socket.emit('lookup',null);socket.emit('connect');socket.emit('secureConnect');req.emit('finish');
   const response=new EventEmitter();response.statusCode=200;callback(response);response.emit('aborted');
  };return req;
 }),{code:'ECONNRESET'});
 assert.deepEqual(stages,['upstream_serialized','upstream_socket','upstream_dns','upstream_tcp','upstream_tls','upstream_sent','upstream_headers']);
});

test('proxy allows n=4 custom size in one edit call and returns all images; rejects invalid options before upstream',async()=>{
 let calls=0;const key='m'.repeat(32);
 const server=createProxy({apiKey:'fake-feature-key',token:key,origins:['https://shop.github.io'],memoryAvailable:()=>1024**3,logger:()=>{},fetcher:async(url,init)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/images/edits');assert.equal(init.headers.Authorization,'Bearer fake-feature-key');assert.equal(init.body.get('n'),'4');assert.equal(init.body.get('size'),'1536x864');return Response.json({data:Array.from({length:4},(_,i)=>({b64_json:'mock-'+i}))});
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 try {
  const form=new FormData();for(const [k,v] of Object.entries({model:'gpt-image-2',prompt:'场景',size:'1536x864',n:'4',output_format:'png'}))form.append(k,v);form.append('image[]',new Blob(['mock-file'],{type:'image/png'}),'reference.png');
  const headers={Origin:'https://shop.github.io',Authorization:'Bearer '+key};const response=await fetch(url+'/v1/images/edits',{method:'POST',headers,body:form});assert.equal(response.status,200);assert.equal((await response.json()).data.length,4);assert.equal(calls,1);
  form.append('n','10');const duplicate=await fetch(url+'/v1/images/edits',{method:'POST',headers,body:form});assert.equal(duplicate.status,400);assert.equal(calls,1);
  for(const change of [{n:11},{n:0},{size:'1025x1024'},{size:'3840x2160',n:2}]){
   const r=await fetch(url+'/v1/images/generations',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:'场景',size:'1024x1024',n:4,output_format:'png',...change})});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'INVALID_IMAGE_OPTIONS');
  }assert.equal(calls,1);
 }finally{await new Promise(r=>server.close(r));}
});

test('proxy low-memory admission rejects before a paid call',async()=>{
 const server=createProxy({apiKey:'fake-memory-key',token:'r'.repeat(32),origins:['https://shop.github.io'],memoryAvailable:()=>1,logger:()=>{},fetcher:()=>assert.fail('must not pay')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/images/generations',{method:'POST',headers:{Origin:'https://shop.github.io',Authorization:'Bearer '+'r'.repeat(32),'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:'场景',size:'1024x1024',n:4,output_format:'png'})});assert.equal(r.status,503);assert.equal((await r.json()).error.code,'RESOURCE_LIMIT');}
 finally{await new Promise(r=>server.close(r));}
});

test('oversize upstream result keeps RESULT_TOO_LARGE even when destroy emits aborted first',async()=>{
 const {EventEmitter}=require('node:events');const {openAIRequest}=require('../server/image-proxy.cjs');const {MAX_RESPONSE_BYTES}=require('../server/image-rules.js');
 await assert.rejects(openAIRequest('https://api.openai.com/v1/images/generations',{headers:{},body:'{}',signal:new AbortController().signal},(url,options,callback)=>{
  const req=new EventEmitter();req.end=()=>{const response=new EventEmitter();response.statusCode=200;response.destroy=e=>{response.emit('aborted');response.emit('error',e);};callback(response);response.emit('data',{length:MAX_RESPONSE_BYTES+1});};return req;
 }),{code:'RESULT_TOO_LARGE'});
});
