/* Public GPT Image 2 validation, shared by browser and proxy; no secrets. */
(function(root) {
  const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
  function validate(size, count = 1) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw Error('生成数量必须为 1～10 的整数');
    const match = /^(\d+)x(\d+)$/.exec(String(size));
    if (!match) throw Error('图片尺寸须为 WIDTHxHEIGHT 格式');
    const width = Number(match[1]), height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width % 16 || height % 16) throw Error('宽度和高度必须是大于 0 的 16 的倍数');
    if (Math.max(width,height) > 3840) throw Error('图片最长边不能超过 3840 像素');
    if (width > height * 3 || height > width * 3) throw Error('图片宽高比必须在 1:3～3:1 之间');
    const pixels = width * height;
    if (pixels < 655360 || pixels > 8294400) throw Error('图片总像素必须在 655360～8294400 之间');
    return {size:width+'x'+height, n, width, height};
  }
  // Conservative uncompressed PNG + Base64 budget, checked before a paid call.
  function checkResultBudget(size, count) {
    const v = validate(size, count);
    const estimatedBytes = Math.ceil(v.width*v.height*v.n*4*4/3 + v.n*65536);
    if (estimatedBytes > MAX_RESPONSE_BYTES) throw Error('本批图片预计超过中转 64MiB 结果上限，请降低生成数量或尺寸；尚未提交生图');
    return {...v,estimatedBytes};
  }
  function generationMode(value, legacyCrop = false) {
    const mode = value ?? (legacyCrop === true ? 'crop_2x2' : 'standard');
    if (!['standard','crop_2x2','crop_3x1'].includes(mode)) throw Error('不支持的模板生成策略');
    return mode;
  }
  function detailGeometry(width, height, insetRatio = 1/64) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width<=0 || height<=0 || width%3) throw Error('详情拼版宽度必须能被3整除，且宽高为正整数');
    const column=width/3;
    if (column*16!==height*9) throw Error('详情拼版每列必须为精确9:16比例，不能拉伸；建议3456×2048');
    if (!Number.isFinite(insetRatio) || insetRatio<0 || insetRatio>=0.5) throw Error('详情图内缩比例必须大于等于0且小于0.5');
    const units=Math.round((height/16)*insetRatio), insetX=9*units, insetY=16*units;
    if (column-2*insetX<=0 || height-2*insetY<=0) throw Error('详情图片太小或内缩过大，裁切后无有效像素');
    return {column,insetX,insetY,width:column-2*insetX,height:height-2*insetY};
  }
  function generationOptions(size, count, mode, insetRatio = 1/64) {
    mode=generationMode(mode);
    const value=checkResultBudget(size,mode==='standard'?count:1);
    if (mode==='crop_2x2' && value.width!==value.height) throw Error('自动裁切模式只接受正方形图片，建议2880×2880');
    if (mode==='crop_3x1') detailGeometry(value.width,value.height,insetRatio);
    return {...value,generationMode:mode,autoCrop2x2:mode==='crop_2x2',detailInsetRatio:insetRatio};
  }
  function isOfficialKey(value) { return /^(?:Bearer\s+)?sk-/i.test(String(value || '').trim()); }
  const api = {generationMode, detailGeometry, generationOptions, isOfficialKey, validate, checkResultBudget, MAX_RESPONSE_BYTES};
  if (typeof module !== 'undefined') module.exports = api; else root.ImageRules = api;
})(globalThis);
