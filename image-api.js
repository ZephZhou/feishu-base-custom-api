/* Shared browser/Node image pipeline. No credentials or external dependencies. */
(function (root) {
  const rules = typeof module !== 'undefined' ? require('./server/image-rules.js') : root.ImageRules;
  const AUTO_CROP_INSET_PX = 24;
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
  // Lookup values can expose computed attachment data (type:17, value:[...]).
  // Only accept image attachments with tokens and never reinterpret text as an image.
  function lookupImages(cell) {
    const results=[];
    const visit=(item,depth)=>{
      if(depth>5 || item == null) return;
      if(Array.isArray(item)) {for(const v of item)visit(v,depth+1);return;}
      if(typeof item!=='object')return;
      if(Array.isArray(item.value)) {visit(item.value,depth+1);return;}
      if(typeof item.token!=='string' && typeof item.file_token!=='string')return;
      const token=item.token || item.file_token, name=item.name || '', type=item.type || '';
      if(typeof token==='string' && token && isImage({name,type})) results.push({token,name,type});
    };
    visit(cell,0);
    return results;
  }
  function assertProductImageFields(metas = []) {
    if(metas.some(f=>f.type===20 && /图|图片|照片|封面|相片|image|photo|picture|thumbnail/i.test(String(f.name||'')))) {
      throw Error('公式图片输入列不支持直接取得原始附件，请改选普通附件列或查找引用图片列；本次未请求生图API。');
    }
  }
  async function lookupAttachmentUrls(table,fid,rid,limit=16) {
    const cell=await table.getCellValue(fid,rid);
    const images=lookupImages(cell);
    if(images.length>limit)throw Error('本行查找引用商品图片超过'+limit+'张');
    if(!images.length)throw Error('当前SKU的查找引用未返回可识别的图片附件token。请确认该列引用的是附件类型，并检查源表匹配。本次未调用生图API。');
    let urls;
    try {urls=await table.getCellAttachmentUrls(images.map(x=>x.token),fid,rid);}
    catch {throw Error('查找引用中找到了图片token，但飞书拒绝使用引用单元格的权限上下文下载。需按源表字段ID和源记录ID读取原始附件；本次未调用生图API。');}
    if(!Array.isArray(urls)||urls.length!==images.length||urls.some(x=>typeof x!=='string'||!/^https:\/\//.test(x)))throw Error('引用附件下载链接不可用，本次未调用生图API');
    return urls;
  }
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
    return validateImageBlob(await response.blob());
  }
  async function validateImageBlob(blob) {
    if (!MIME[blob.type] || !blob.size || blob.size >= 50 * 1024 * 1024) throw Error('图片须为非空 PNG/JPEG/WebP，且小于 50MB');
    const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const valid = blob.type === 'image/png' ? b[0]===137 && b[1]===80 && b[2]===78 && b[3]===71 : blob.type === 'image/jpeg' ? b[0]===255 && b[1]===216 && b[2]===255 : String.fromCharCode(...b.slice(0,4))==='RIFF' && String.fromCharCode(...b.slice(8,12))==='WEBP';
    if (!valid) throw Error('图片内容与 MIME 不符，可能下载到了错误页面');
    return blob;
  }
  async function generate({ base, key, model = 'gpt-image-2', size, n = 1, autoCrop2x2 = false, generationMode, detailInsetRatio = 1/64, brandImages = [], text, imageUrls = [], onProgress = () => {} }, signal, fetcher = fetch) {
    if (!text.trim()) throw Error('图片模式请填写场景提示词');
    generationMode=rules.generationMode(generationMode,autoCrop2x2);
    const params=rules.generationOptions(size,n,generationMode,detailInsetRatio);
    ({size,n,autoCrop2x2} = params);
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
      return {images, edit, requestId, expectedCount:n, autoCrop2x2, generationMode, detailInsetRatio};
    } catch (e) {
      const detail = e.safeHTTP ? e.message : e.name === 'AbortError' ? '图片请求超时或已停止' : '图片请求未完成：可能为网络/CORS、附件下载或响应中断';
      const error = new Error(detail + '；请求ID ' + requestId + '；阶段 ' + stage + '；耗时 ' + ((Date.now()-started)/1000).toFixed(1) + '秒。状态可能不确定，请核对服务端日志，勿盲目重试以免重复扣费');
      if (e.name === 'AbortError') error.name = 'AbortError';
      throw error;
    }
  }

  function checkCropSupport(runtime = root) {
    if (typeof runtime.createImageBitmap !== 'function' &&
        !(typeof runtime.Image === 'function' && typeof runtime.URL?.createObjectURL === 'function')) {
      throw Error('当前浏览器不支持 createImageBitmap 或 Image 解码，无法自动裁切');
    }
    let canvas,ctx;
    try{canvas=runtime.document.createElement('canvas');ctx=canvas.getContext('2d');}catch{}
    if(!ctx || typeof canvas?.toBlob!=='function')throw Error('当前浏览器 Canvas 2D 或 toBlob 不可用，无法自动裁切，请取消勾选');
    return {canvas,ctx};
  }
  async function decodeCropImage(blob, runtime) {
    try {
      if (typeof runtime.createImageBitmap === 'function') {
        const bitmap = await runtime.createImageBitmap(blob, {imageOrientation:'none',premultiplyAlpha:'none',colorSpaceConversion:'none'});
        return {image:bitmap, width:bitmap.width, height:bitmap.height, release:() => bitmap.close?.()};
      }
    } catch { /* Use the browser image decoder if createImageBitmap fails. */ }
    const url = runtime.URL.createObjectURL(blob);
    try {
      const image = new runtime.Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      return {image, width:image.naturalWidth, height:image.naturalHeight, release:() => runtime.URL.revokeObjectURL(url)};
    } catch (e) {
      runtime.URL.revokeObjectURL(url);
      throw e;
    }
  }
  function throwIfStopped(signal) {
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
  }
  async function cropImage(blob, signal, runtime, layout, hooks = {}) {
    const {canvas, ctx} = checkCropSupport(runtime);
    let decoded;
    try {
      throwIfStopped(signal);
      try { decoded = await decodeCropImage(blob, runtime); }
      catch { throw Error('无法解码原始拼版图，请下载原图'); }
      const {image, width, height} = decoded;
      hooks.onDecoded?.(width, height);
      const {width: outputWidth, height: outputHeight, origins} = layout(width, height);
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      ctx.imageSmoothingEnabled = false;
      const images = [];
      for (const [x, y] of origins) {
        throwIfStopped(signal);
        ctx.clearRect(0, 0, outputWidth, outputHeight);
        ctx.drawImage(image, x, y, outputWidth, outputHeight, 0, 0, outputWidth, outputHeight);
        let part;
        try {
          part = await new Promise((resolve, reject) => {
            canvas.toBlob(value => value?.size ? resolve(value) : reject(Error('empty canvas result')), 'image/png');
          });
        } catch { throw Error('Canvas 裁切导出失败，请下载原图'); }
        images.push(part);
        await hooks.onPart?.(part, images.length - 1, outputWidth, outputHeight);
      }
      throwIfStopped(signal);
      return images;
    } finally {
      decoded?.release();
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  async function crop2x2(blob, signal, runtime = root, inset = AUTO_CROP_INSET_PX, hooks) {
    if(!Number.isSafeInteger(inset) || inset<0)throw Error('安全内缩量必须为非负整数像素');
    return cropImage(blob, signal, runtime, (width, height) => {
      if(width!==height)throw Error('原始图片为 '+width+'×'+height+'，不是正方形，未裁切或拉伸；请下载原图');
      if(!Number.isSafeInteger(width) || width<2 || width%2)throw Error('原始图片边长须为大于等于2的偶数，才能无损等分四张；请下载原图');
      const side=width/2, outputSide=side-2*inset;
      if(outputSide<1)throw Error('原始图片太小，每个象限四边内缩'+inset+'px后无有效像素；请下载原图');
      const origins = [[0,0],[side,0],[0,side],[side,side]].map(([x,y]) => [x+inset,y+inset]);
      return {width:outputSide, height:outputSide, origins};
    }, hooks);
  }
  async function crop3x1(blob, signal, runtime = root, insetRatio = 1/64, hooks) {
    return cropImage(blob, signal, runtime, (width, height) => {
      const g = rules.detailGeometry(width, height, insetRatio);
      const origins = [0, 1, 2].map(i => [i*g.column + g.insetX, g.insetY]);
      return {width:g.width, height:g.height, origins};
    }, hooks);
  }
  function errorDetail(error) {
    const cause = error?.error ?? error;
    const message = cause?.message || cause?.msg || error?.message || (typeof error === 'string' ? error : '未知错误');
    const code = cause?.code ?? error?.code;
    const detail = String(message).replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 300);
    return code == null || detail.includes(String(code)) ? detail : `错误码 ${code}，${detail}`;
  }
  async function imageStage(stage, action) {
    try {
      return await action();
    } catch (cause) {
      const error = new Error(`${stage} 失败 · ${errorDetail(cause)}`, {cause});
      if (cause?.name === 'AbortError') error.name = cause.name;
      throw error;
    }
  }
  async function keepCheckpoint(save, report) {
    try { await save(); }
    catch (e) { report('recovery_save', errorDetail(e), true); }
  }
  function imageFile(blob, rid, index, mode = 'standard') {
    const prefix = mode === 'standard' ? 'ai_' : (mode === 'crop_3x1' ? '详情页' : '主图') + String(index+1).padStart(2,'0') + '_';
    return new File([blob], `${prefix}${rid.slice(-6)}_${Date.now()}_${index+1}.${MIME[blob.type]}`, {type:blob.type});
  }
  function resultBytes(base64) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) throw Error('返回的 Base64 图片无效');
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  async function recrop({job, signal, onCheckpoint = () => {}, report = () => {}}) {
    await imageStage('crop', async () => {
      if (job.originals.length !== 1) throw Error('裁切模式预期1张拼版图，实际返回'+job.originals.length+'张；原图已保留供下载');
      const [original] = job.originals;
      const hooks = {
        onDecoded: (width, height) => {
          report('original_image', `${width}×${height} · ${original.type} · ${original.size} 字节`);
          report('crop_start', `开始裁切 · ${job.mode}`);
        },
        onPart: async (blob, i, width, height) => {
          job.crops[i] = imageFile(blob, job.rid, i, job.mode);
          report('crop_part', `第 ${i+1} 张已裁切 · ${width}×${height}`);
          await keepCheckpoint(() => onCheckpoint(job), report);
        }
      };
      if (job.mode === 'crop_3x1') await crop3x1(original, signal, root, job.detailInsetRatio, hooks);
      else await crop2x2(original, signal, root, AUTO_CROP_INSET_PX, hooks);
      job.cropComplete = true;
      await keepCheckpoint(() => onCheckpoint(job), report);
      report('crop_complete', `裁切成功 ${job.crops.length} 张`);
    });
  }
  async function uploadAndWrite({table, base, fid, rid, files, signal, append, job, onCheckpoint, report}) {
    const readExisting = () => imageStage('getCellValue', async () => {
      const value = append ? await table.getCellValue(fid, rid) : [];
      if (value != null && !Array.isArray(value)) throw Error('输出不是附件字段');
      return value || [];
    });
    let uploads = files.map((file, index) => ({file, index}));
    const attachments = job?.attachments?.slice() || [];
    // A rejected SDK promise can arrive after the cell has already been updated.
    // Recover only the files still missing from that previous write attempt.
    const isPresent = (attachment, existing) => attachment && existing.some(value => value?.token === attachment.token && value?.name === attachment.name);
    if (attachments.length) {
      const existing = await readExisting();
      uploads = uploads.filter(({index}) => !isPresent(attachments[index], existing));
    }
    throwIfStopped(signal);
    if (uploads.length) {
      await imageStage('batchUploadFile', async () => {
        report('upload_start', `开始上传飞书附件 · ${uploads.length} 张`);
        const tokens = await base.batchUploadFile(uploads.map(({file}) => file));
        const count = Array.isArray(tokens) ? tokens.filter(t => typeof t === 'string' && t).length : 0;
        if (tokens?.length !== uploads.length || count !== uploads.length) {
          throw Error(`飞书上传未返回全部附件 token（${count}/${uploads.length}），输出单元格未修改`);
        }
        uploads.forEach(({file, index}, i) => {
          attachments[index] = {name:file.name, size:file.size, type:file.type, token:tokens[i], timeStamp:file.lastModified};
        });
        report('upload_complete', `上传成功 ${count} 张`);
      });
      if (job) {
        job.attachments = attachments;
        await keepCheckpoint(() => onCheckpoint(job), report);
      }
    }
    throwIfStopped(signal);
    const existing = await readExisting();
    const missing = attachments.filter(value => !isPresent(value, existing));
    if (missing.length) {
      await imageStage('setCellValue', async () => {
        throwIfStopped(signal);
        report('write_start', `开始回写字段 ${fid}`);
        const written = await table.setCellValue(fid, rid, [...existing, ...missing]);
        if (written === false) throw Error('飞书 SDK 返回 false');
      });
    }
    report('write_complete', `回写成功 · ${files.length} 张附件已在字段 ${fid}`);
    return files.reduce((sum, file) => sum + file.size, 0);
  }
  async function uploadCrops({job, table, base, signal, onCheckpoint = () => {}, report = () => {}}) {
    if (!job.cropComplete) throw Error('请先完成重新裁切');
    return uploadAndWrite({table, base, fid:job.fid, rid:job.rid, files:job.crops, signal, append:true, job, onCheckpoint, report});
  }
  async function write({table, base, fid, rid, result, signal, append = false, job, onCheckpoint = () => {}, onOriginal = () => {}, report = () => {}}, fetcher = fetch) {
    const images = result.images || [result];
    if (!images.length || images.length > 10) throw Error('返回的图片数量无效');
    const mode = rules.generationMode(result.generationMode, result.autoCrop2x2);
    report('generation_mode', `结果生成策略 · ${mode}`);
    const files = [];
    if (mode !== 'standard') {
      job ??= {rid, fid};
      Object.assign(job, {mode, detailInsetRatio:result.detailInsetRatio ?? 1/64, originals:[], crops:[], cropComplete:false});
    }
    for (const [i, image] of images.entries()) {
      const blob = await imageStage('result_blob', async () => image.b64
        ? validateImageBlob(new Blob([resultBytes(image.b64)], {type:'image/png'}))
        : imageBlob(await fetcher(image.url, {signal})));
      if (mode === 'standard') files.push(imageFile(blob, rid, i));
      else {
        job.originals.push(blob);
        report('original_saved', `已取得拼版原图 ${i+1} · ${blob.type} · ${blob.size} 字节`);
        await keepCheckpoint(() => onCheckpoint(job), report);
        await keepCheckpoint(() => onOriginal(blob), report);
      }
    }
    if (mode !== 'standard') {
      await recrop({job, signal, onCheckpoint, report});
      return uploadAndWrite({table, base, fid, rid, files:job.crops, signal, append, job, onCheckpoint, report});
    }
    return uploadAndWrite({table, base, fid, rid, files, signal, append, report});
  }
  const api = {checkCropSupport, crop2x2, crop3x1, endpoint, isImage, lookupImages, lookupAttachmentUrls, assertProductImageFields, attachmentUrls, imageBlob, generate, write, recrop, uploadCrops};
  if (typeof module !== 'undefined') module.exports = api; else root.ImageAPI = api;
})(globalThis);
