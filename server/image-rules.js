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
  function isOfficialKey(value) { return /^(?:Bearer\s+)?sk-/i.test(String(value || '').trim()); }
  const api = {isOfficialKey, validate, checkResultBudget, MAX_RESPONSE_BYTES};
  if (typeof module !== 'undefined') module.exports = api; else root.ImageRules = api;
})(globalThis);
