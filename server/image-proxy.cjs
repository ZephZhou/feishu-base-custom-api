// Node >= 22. Fixed OpenAI upstream; never accepts upstream URLs or keys from clients.
const http = require('node:http');
const https = require('node:https');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const UPLOAD_TIMEOUT_MS = 300000;
const GENERATION_TIMEOUT_MS = 600000;

// Native HTTPS avoids fetch's implicit 300s headers timeout for image generation.
async function openAIRequest(url, {headers, body, signal, trace = () => {}, connectTimeoutMs = 30000}, requestImpl = https.request) {
  // Serialize multipart with the standard Request implementation, including boundary.
  const request = new Request(url, {method:'POST', headers, body, signal});
  const bytes = await request.arrayBuffer();
  trace('upstream_serialized', {bytes:bytes.byteLength});
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let connectTimer;
    const upstream = requestImpl(url, {method:'POST', headers:{...Object.fromEntries(request.headers), 'content-length':String(bytes.byteLength)}, signal}, response => {
      clearTimeout(connectTimer);
      trace('upstream_headers', {status:response.statusCode});
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) response.destroy(new Error('Upstream response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => { const error = new Error('Upstream response aborted'); error.code = 'ECONNRESET'; reject(error); });
      response.on('end', () => { trace('upstream_body', {bytes:size}); resolve({ok:response.statusCode >= 200 && response.statusCode < 300, status:response.statusCode, json:async()=>JSON.parse(Buffer.concat(chunks).toString())}); });
    });
    // This deadline covers DNS, TCP and TLS only, not model generation.
    connectTimer = setTimeout(() => { const error = new Error('Upstream connection timeout'); error.code = 'ETIMEDOUT'; upstream.destroy(error); }, connectTimeoutMs);
    upstream.on('socket', socket => {
      trace('upstream_socket');
      if (upstream.reusedSocket) { clearTimeout(connectTimer); trace('upstream_reused_socket'); return; }
      socket.once('lookup', error => { if (!error) trace('upstream_dns'); });
      socket.once('connect', () => trace('upstream_tcp'));
      const secure = () => { clearTimeout(connectTimer); trace('upstream_tls'); };
      socket.once('secureConnect', secure);
    });
    upstream.on('finish', () => trace('upstream_sent'));
    upstream.on('error', error => { clearTimeout(connectTimer); reject(error); });
    upstream.end(Buffer.from(bytes));
  });
}
function createProxy({apiKey, token, origins, fetcher = openAIRequest, maxBytes = 52 * 1024 * 1024, generationTimeoutMs = GENERATION_TIMEOUT_MS, logger = record => console.log(JSON.stringify(record))}) {
  if (!apiKey || !token || token.length < 32 || !origins?.length || origins.includes('*')) throw Error('配置 OPENAI_API_KEY、至少32字符的 PROXY_TOKEN 和明确的 ALLOWED_ORIGINS');
  let active = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
      return res.end(JSON.stringify({status:'ok'}));
    }
    const started = Date.now();
    const candidate = req.headers['x-request-id'];
    const requestId = typeof candidate === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : randomUUID();
    const method = ['GET','POST','OPTIONS'].includes(req.method) ? req.method : 'other';
    const route = req.url === '/v1/images/edits' ? 'edits' : req.url === '/v1/images/generations' ? 'generations' : 'other';
    let stage = 'request_received';
    const trace = (next, details = {}) => {
      stage = next;
      // Only call with internal stage names and explicitly selected numeric metadata.
      try { logger({time:new Date().toISOString(), request_id:requestId, stage, elapsed_ms:Date.now()-started, method, route, ...details}); } catch {}
    };
    res.setHeader('X-Request-ID', requestId);
    trace('request_received');
    res.on('finish', () => trace('response_finished', {status:res.statusCode}));
    res.on('close', () => { if (!res.writableEnded) trace('client_disconnected'); });
    const origin = req.headers.origin;
    const reply = (status, message) => { res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'}); res.end(JSON.stringify({error:{message}, request_id:requestId})); };
    if (!origins.includes(origin)) return reply(403, 'Origin denied');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
    if (!['/v1/images/edits','/v1/images/generations'].includes(req.url)) return reply(404, 'Not found');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, X-Request-ID','Access-Control-Max-Age':'600'}); return res.end();
    }
    if (req.method !== 'POST') return reply(405, 'POST required');
    const auth = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from('Bearer ' + token);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(401, 'Invalid proxy token');
    if (active >= 2) return reply(429, 'Proxy busy; retry manually');
    trace('authorized');
    active++;
    const controller = new AbortController();
    let timer;
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      trace('upload_receiving');
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > maxBytes) { reply(413, 'Request too large'); return; } chunks.push(chunk); }
      trace('upload_received', {bytes:length});
      const type = req.headers['content-type'] || '';
      const raw = Buffer.concat(chunks);
      const edit = req.url.endsWith('/edits');
      let data, body;
      const headers = {Authorization:'Bearer ' + apiKey};
      if (edit) {
        if (!type.startsWith('multipart/form-data;')) return reply(415,'Edits require multipart/form-data');
        data = await new Request('http://localhost', {method:'POST', headers:{'Content-Type':type}, body:raw}).formData();
        const allowed = new Set(['model','prompt','size','n','output_format','image[]']);
        if ([...data.keys()].some(k=>!allowed.has(k))) return reply(400,'Unsupported edit field');
        const images = data.getAll('image[]');
        if (!images.length || images.length > 16 || images.some(i=> typeof i === 'string' || !['image/png','image/jpeg','image/webp'].includes(i.type) || !i.size || i.size >= 50*1024*1024)) return reply(400,'Invalid reference images');
        body = data;
      } else {
        if (!type.startsWith('application/json')) return reply(415,'JSON required');
        data = JSON.parse(raw.toString());
        if (Object.keys(data).some(k=>!['model','prompt','size','n','output_format'].includes(k))) return reply(400,'Unsupported generation field');
        body = JSON.stringify(data); headers['Content-Type']='application/json';
      }
      const get = k => edit ? data.get(k) : data[k];
      if (get('model') !== 'gpt-image-2' || String(get('n')) !== '1' || get('output_format') !== 'png' || !['1024x1024','1024x1536','1536x1024'].includes(get('size')) || typeof get('prompt') !== 'string' || !get('prompt').trim() || get('prompt').length > 32000) return reply(400,'Invalid model, prompt, size or output options');
      trace('validated');
      // Upload parsing has its own server deadline; generation gets a fresh budget.
      timer = setTimeout(()=>{ trace('generation_timeout'); controller.abort(); }, generationTimeoutMs);
      trace('upstream_start');
      const upstream = await fetcher('https://api.openai.com' + req.url, {method:'POST', headers, body, signal:controller.signal, redirect:'error', trace});
      trace('upstream_result', {status:upstream.status});
      // Do not forward upstream errors, headers or credentials to browser/logs.
      if (!upstream.ok) return reply(upstream.status, 'OpenAI request failed; check account permissions, quota and parameters');
      const result = await upstream.json();
      trace('response_parsed');
      if (!result.data?.[0]?.b64_json) return reply(502,'OpenAI response missing image');
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({data:[{b64_json:result.data[0].b64_json}]}));
    } catch (e) {
      const failedStage = stage;
      const codes = new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
      trace('request_failed', {failed_stage:failedStage, error_code:codes.has(e.code) ? e.code : controller.signal.aborted ? 'ABORTED' : 'OTHER'});
      if (!res.headersSent && !res.destroyed) reply(controller.signal.aborted ? 504 : 502, 'Image proxy request failed; no automatic retry'); }
    finally { clearTimeout(timer); active--; }
  });
  // requestTimeout covers receiving the upload, not waiting for OpenAI's response.
  server.requestTimeout = UPLOAD_TIMEOUT_MS;
  server.headersTimeout = 60000;
  server.timeout = 0;
  return server;
}
function listenOptions(env = process.env) {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('PORT must be an integer from 0 to 65535');
  return {port, host:env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1'};
}
function startProxy(env = process.env) {
  const options = listenOptions(env);
  const server = createProxy({apiKey:env.OPENAI_API_KEY, token:env.PROXY_TOKEN, origins:(env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean)});
  server.listen(options.port, options.host, () => console.log('Image proxy listening on ' + options.host + ':' + server.address().port));
  return server;
}
if (require.main === module) startProxy();
module.exports = {openAIRequest, createProxy, listenOptions, startProxy, UPLOAD_TIMEOUT_MS, GENERATION_TIMEOUT_MS};
