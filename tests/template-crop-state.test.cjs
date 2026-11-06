'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const opts = require('../image-options.js');

function mockStorage(value) {
  const saved = new Map();
  if (value !== undefined) saved.set(opts.TEMPLATE_KEY, JSON.stringify(value));
  return {
    getItem(key) { return saved.has(key) ? saved.get(key) : null; },
    setItem(key, value) { saved.set(key, value); },
  };
}

test('legacy main/detail templates migrate without clearing their prompts', () => {
  const storage = mockStorage([
    {id:'main', name:'主图模板', prompt:'保留用户的长主图提示词', n:1, size:'2880x2880'},
    {id:'detail', name:'详情页模板', prompt:'保留用户的详情提示词', n:3, size:'1024x1536'},
  ]);
  const old = opts.loadTemplates(storage);
  assert.equal(old[0].autoCrop2x2, false);
  assert.equal(old[1].autoCrop2x2, false);
  const updated = old.map(t=>t.id==='main'?{...t,autoCrop2x2:true}:t);
  assert.doesNotThrow(()=>opts.saveTemplates(storage,updated));
  const restored = opts.loadTemplates(storage);
  assert.equal(restored.find(t=>t.id==='main').autoCrop2x2,true);
  assert.equal(restored.find(t=>t.id==='detail').autoCrop2x2,false);
  assert.equal(restored.find(t=>t.id==='main').prompt,'保留用户的长主图提示词');
  assert.equal(restored.find(t=>t.id==='detail').prompt,'保留用户的详情提示词');
});

test('old saved template without checkbox can still be saved directly', () => {
  const storage=mockStorage();
  const old=[{id:'main',name:'主图',prompt:'测试',n:1,size:'2880x2880'}];
  opts.saveTemplates(storage,old);
  assert.equal(opts.loadTemplates(storage)[0].autoCrop2x2,false);
});

test('cropping only allowed for one square input, other templates unchanged', () => {
  const storage=mockStorage();
  assert.throws(()=>opts.saveTemplates(storage,[{id:'x',name:'详情图',prompt:'x',n:3,size:'1024x1536',autoCrop2x2:true}]),/n=1/);
  assert.doesNotThrow(()=>opts.saveTemplates(storage,[{id:'x',name:'详情图',prompt:'x',n:3,size:'1024x1536',autoCrop2x2:false}]));
});

test('reject corrupted non-boolean crop settings', () => {
  const storage=mockStorage([{id:'main',name:'主图',prompt:'x',n:1,size:'2880x2880',autoCrop2x2:'true'}]);
  assert.throws(()=>opts.loadTemplates(storage),/字段格式错误/);
});
