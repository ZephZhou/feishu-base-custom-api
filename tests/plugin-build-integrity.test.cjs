'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const image=require('../image-api.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const version='2026.11.25.1';
const query='20261125.1';

test('HTML and image API expose the same build identifier',()=>{
  assert.equal(image.BUILD_ID,version);
  assert.match(html,/const APP_BUILD = '2026\.11\.25\.1';/);
  assert.match(html,/<span class="buildTag" id="appBuild"/);
  assert.match(html,/<span id="buildState" role="status"/);
});

test('image API and options have cache-busting version query',()=>{
  assert.ok(html.includes('src="./image-api.js?v='+query+'"'));
  assert.ok(html.includes('src="./image-options.js?v='+query+'"'));
});

test('version mismatch blocks request before batch is started',()=>{
  assert.match(html,/if \(!checkBuildVersion\(\)\) throw Error\('插件组件版本不一致/);
  assert.match(html,/图片模块 '+\(window\.ImageAPI\?\.BUILD_ID/);
  const guard=html.indexOf("if (!checkBuildVersion()) throw Error(");
  const after=html.indexOf("imageRunOptions = imageOptions.snapshot();",guard);
  assert.ok(guard>0 && after>guard,'check is before image mode snapshot and paid API');
});

test('cross-table lookup implementation remains enabled',()=>{
  assert.equal(typeof image.lookupAttachmentUrls,'function');
  assert.match(html,/ImageAPI\.lookupAttachmentUrls\(table, meta\.id, recordId/);
  assert.ok(!html.includes('不是普通附件列：插件当前无法从跨表引用取到原始附件下载地址'));
});
