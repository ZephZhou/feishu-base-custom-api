'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const options=require('../image-options.js');

const oldTemplates=[
  {id:'main',name:'主图模板',prompt:'已经调好的四张主图提示词',generationMode:'crop_2x2',size:'2880x2880',n:1},
  {id:'detail',name:'详情页模板',prompt:'已经调好的三列详情提示词',generationMode:'crop_3x1',size:'3456x2048',n:1},
];
function localStorageMock() {
  const data=new Map([[options.TEMPLATE_KEY,JSON.stringify(oldTemplates)]]);
  return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
}

test('legacy templates preserve prompts, modes and names when adding output mappings',()=>{
  const storage=localStorageMock();
  const templates=options.loadTemplates(storage);
  const saved=templates.map(t=>({...t,outputFieldId:t.id==='main'?'att_main':'att_detail',outputTableId:'table123'}));
  options.saveTemplates(storage,saved);
  const restored=options.loadTemplates(storage);
  assert.equal(restored[0].prompt,oldTemplates[0].prompt);
  assert.equal(restored[1].prompt,oldTemplates[1].prompt);
  assert.equal(restored[0].generationMode,'crop_2x2');
  assert.equal(restored[1].generationMode,'crop_3x1');
  assert.equal(restored[0].outputFieldId,'att_main');
  assert.equal(restored[1].outputFieldId,'att_detail');
  assert.equal(restored[0].outputTableId,'table123');
});

test('switching templates resolves separate output columns in the same table',()=>{
  const fields=['att_main','att_detail'];
  assert.deepEqual(options.resolveTemplateOutput({outputFieldId:'att_main',outputTableId:'t1'},'t1',fields),{status:'ok',fieldId:'att_main'});
  assert.deepEqual(options.resolveTemplateOutput({outputFieldId:'att_detail',outputTableId:'t1'},'t1',fields),{status:'ok',fieldId:'att_detail'});
});

test('deleted field or switched table cannot silently select another field',()=>{
  assert.deepEqual(options.resolveTemplateOutput({outputFieldId:'att_main',outputTableId:'t1'},'t2',['other']),{status:'wrong_table',fieldId:''});
  assert.deepEqual(options.resolveTemplateOutput({outputFieldId:'att_main',outputTableId:'t1'},'t1',['att_detail']),{status:'missing',fieldId:''});
});

test('old templates remain readable and explicitly unbound until saved once',()=>{
  const original=options.loadTemplates(localStorageMock());
  assert.equal(options.resolveTemplateOutput(original[0],'t1',['att_main']).status,'unbound');
  assert.equal(options.resolveTemplateOutput(original[1],'t1',['att_detail']).status,'unbound');
});

test('rejects invalid output mapping types without modifying saved data',()=>{
  const storage=localStorageMock(), before=storage.getItem(options.TEMPLATE_KEY);
  assert.throws(()=>options.saveTemplates(storage,[{...oldTemplates[0],outputFieldId:123}]),/输出列配置格式错误/);
  assert.equal(storage.getItem(options.TEMPLATE_KEY),before);
});
