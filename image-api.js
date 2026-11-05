/* Shared browser/Node image pipeline. No credentials or external dependencies. */
(function (root) {
  const rules = typeof module !== 'undefined' ? require('./server/image-rules.js') : root.ImageRules;
  const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  function endpoint(base, kind) {
    const u = new URL(base.trim());
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('API 地址必须为无查询参数的 HTTP(S) 地址');
    u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|images\/(?:generations|edits))$/, '');
    if (!u.pathname || u.pathname === '/') u.pathname = '/v1';
    u.pathname += '/images/' + kind;
    return u.href;
  }
  function isImage(a) { return !!a && (/^image\//i.test(a.type || '') || /\.(png|jpe?g|webp)$/i.test(a.name || '')); }
  async function attachmentUrls(table, fid, rid, limit = 16) {
    const cell = await table.getCellValue(fid, rid);
    const images = (Array.isArray(cell) ? cell : []).filter(isImage);
    if (images.length > limit) throw Error('每行最多支持 ' + limit + ' 张参考图');
    if (!images.length) return [];
    if (images.some(a => !a.token)) throw Error('参考图缺少附件 token');
    // Official table method preserves field/record permission context.
    const urls = await table.getCellAttachmentUrls(images.map(a => a.token), fid, rid);
    if (!Array.isArray(urls) || urls.length !== images.length || urls.some(u => typeof u !== 'string' || !u)) throw Error('无法取得参考图临时下载地址，请刷新飞书权限后重试');
    return urls;
  }
  async function imageBlob(response) {
    if (!response.ok) throw Error('下载图片失败 HTTP ' + response.status);
    const blob = await response.blob();
    if (!MIME[blob.type] || !blob.size || blob.size >= 50 * 1024 * 1024) throw Error('图片须为非空 PNG/JPEG/WebP，且小于 50MB');
    const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const valid = blob.type === 'image/png' ? b[0]===137 && b[1]===80 && b[2]===78 && b[3]===71 : blob.type === 'image/jpeg' ? b[0]===255 && b[1]===216 && b[2]===255 : String.fromCharCode(...b.slice(0,4))==='RIFF' && String.fromCharCode(...b.slice(8,12))==='WEBP';
    if (!valid) throw Error('图片内容与 MIME 不符，可能下载到了错误页面');
    return blob;
  }
  async function generate({ base, key, model = 'gpt-image-2', size, n = 1, brandImages = [], text, imageUrls = [], onProgress = () => {} }, signal, fetcher = fetch) {
    if (!text.trim()) throw Error('图片模式请填写场景提示词');
    ({size,n} = rules.checkResultBudget(size,n));
    if (rules.isOfficialKey(key)) throw Error('官方 OpenAI Key 只能配置在 Render 服务端；前端请填写 PROXY_TOKEN');
    if (brandImages.length > 4) throw Error('固定品牌参考图最多4张');
    if (imageUrls.length + brandImages.length > 16) throw Error('最多支持16张参考图');
    const requestId = globalThis.crypto.randomUUID();
    const started = Date.now(); let stage;
    const trace = next => { stage = next; try { onProgress({request_id:requestId, stage, elapsed_ms:Date.now()-started}); } catch {} };
    try {
      trace('reference_download');
      const edit = imageUrls.length + brandImages.length > 0;
      const headers = { Authorization: 'Bearer ' + key, 'X-Request-ID':requestId };
      let body;
      if (edit) {
        body = new FormData();
        for (const [i, url] of imageUrls.entries()) {
          const blob = await imageBlob(await fetcher(url, { signal }));
          body.append('image[]', blob, 'reference-' + i + '.' + MIME[blob.type]);
        }
        for (const [i, file] of brandImages.entries()) {
          const blob = await imageBlob(new Response(file, {headers:{'Content-Type':file.type}}));
          body.append('image[]', blob, 'brand-' + i + '.' + MIME[blob.type]);
        }
        if (body.getAll('image[]').reduce((sum,b) => sum+b.size, 0) > 51*1024*1024) throw Object.assign(Error('商品图和品牌图合计过大，请压缩图片后再生成（上传上限52MiB）'), {safeHTTP:true});
        for (const [k,v] of Object.entries({model, prompt:text, size, n:String(n), output_format:'png'})) body.append(k,v);
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({model, prompt:text, size, n, output_format:'png'});
      }
      const url = endpoint(base, edit ? 'edits' : 'generations');
      trace('proxy_request');
      const response = await fetcher(url, {method:'POST', headers, body, signal});
      trace('response_headers');
      if (!response.ok) {
        const codes = {RESOURCE_LIMIT:'中转可用内存不足，请降低行并发、生成数量或尺寸（本次未提交上游）', RESULT_TOO_LARGE:'多图片结果超过中转大小限制，请减少数量或尺寸；本次可能已产生费用，不自动重试', INVALID_IMAGE_OPTIONS:'中转不支持本次数量或尺寸，请同步更新前后端版本，或降低数量/尺寸（本次未提交上游）'};
        let code;try {code=(await response.json()).error?.code;}catch{}
        throw Object.assign(new Error('生图API HTTP ' + response.status + (codes[code] ? '：'+codes[code] : '')), {safeHTTP:true});
      }
      trace('response_body');
      const data = await response.json();
      trace('response_complete');
      const images = (Array.isArray(data.data) ? data.data : []).map(item => {
        if (typeof item?.b64_json === 'string' && item.b64_json) return {b64:item.b64_json};
        if (typeof item?.url === 'string' && /^https:\/\//.test(item.url)) return {url:item.url};
        return null;
      }).filter(Boolean);
      if (!images.length || images.length > 10) throw Object.assign(new Error('生图返回缺少有效 b64_json/url 或图片数量异常'), {safeHTTP:true});
      return {images, edit, requestId, expectedCount:n};
    } catch (e) {
      const detail = e.safeHTTP ? e.message : e.name === 'AbortError' ? '图片请求超时或已停止' : '图片请求未完成：可能为网络/CORS、附件下载或响应中断';
      const error = new Error(detail + '；请求ID ' + requestId + '；阶段 ' + stage + '；耗时 ' + ((Date.now()-started)/1000).toFixed(1) + '秒。状态可能不确定，请核对服务端日志，勿盲目重试以免重复扣费');
      if (e.name === 'AbortError') error.name = 'AbortError';
      throw error;
    }
  }

  async function write({table, base, fid, rid, result, signal, append = false}, fetcher = fetch) {
    const images = result.images || [result];
    if (!images.length || images.length > 10) throw Error('返回的图片数量无效');
    const files = [];
    for (const [i, image] of images.entries()) {
      let response;
      if (image.b64) {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64) || image.b64.length % 4) throw Error('返回的 Base64 图片无效');
        const bytes = Uint8Array.from(atob(image.b64), c => c.charCodeAt(0));
        response = new Response(bytes, {headers:{'Content-Type':'image/png'}});
      } else response = await fetcher(image.url, {signal});
      const blob = await imageBlob(response);
      files.push(new File([blob], 'ai_' + rid.slice(-6) + '_' + Date.now() + '_' + (i+1) + '.' + MIME[blob.type], {type:blob.type}));
    }
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const tokens = await base.batchUploadFile(files);
    if (!Array.isArray(tokens) || tokens.length !== files.length || tokens.some(t=>typeof t!=='string'||!t)) throw Error('飞书上传未返回全部附件 token，未修改输出单元格；勿重复生图以免扣费');
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const existing = append ? await table.getCellValue(fid, rid) : [];
    if (existing != null && !Array.isArray(existing)) throw Error('输出不是附件字段，未修改原结果');
    await table.setCellValue(fid, rid, [...(existing || []), ...files.map((file,i)=>({name:file.name, size:file.size, type:file.type, token:tokens[i], timeStamp:file.lastModified}))]);
    return files.reduce((sum,file)=>sum+file.size,0);
  }
  const api = {endpoint, isImage, attachmentUrls, imageBlob, generate, write};
  if (typeof module !== 'undefined') module.exports = api; else root.ImageAPI = api;
})(globalThis);
