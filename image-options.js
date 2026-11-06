/* Local-only templates and four reference slots. No API keys are stored here. */
(function(root) {
  const rules = typeof module !== 'undefined' ? require('./server/image-rules.js') : root.ImageRules;
  const TEMPLATE_KEY = 'ai-filler-image-templates-v1';
  function defaults() { return [
    {id:'main', name:'主图模板', prompt:'以第一张商品白底图为商品主体，后续图片仅作为品牌风格参考。保持商品外形、颜色、商标及包装文字，生成一张无边框、无间隔的2×2正方形拼版，四格独立完整商品场景，商品不跨格，不添加水印。', generationMode:'crop_2x2', n:1, size:'2880x2880', autoCrop2x2:true},
    {id:'detail', name:'详情页模板', prompt:'以第一张商品白底图为商品主体，后续图片仅作为品牌风格参考。保持商品一致，生成一张无边框无间隔的横向三列拼版，每列独立完整9:16竖版详情图，依次展示产品细节与使用场景，商品不跨列，不虚构功能或添加水印。', generationMode:'crop_3x1', n:1, size:'3456x2048', autoCrop2x2:false, detailInsetRatio:1/64}
  ]; }
  // In-memory migration: never overwrite saved prompts/sizes or infer mode from text/name.
  function normalizeTemplate(template) {
    if (template.generationMode == null && template.autoCrop2x2 !== undefined && typeof template.autoCrop2x2 !== 'boolean') throw Error('模板自动裁切字段格式错误');
    if (template.outputFieldId != null && typeof template.outputFieldId !== 'string') throw Error('模板输出列配置格式错误');
    if (template.outputTableId != null && typeof template.outputTableId !== 'string') throw Error('模板所属数据表配置格式错误');
    const mode=rules.generationMode(template.generationMode,template.autoCrop2x2);
    return {...template,generationMode:mode,autoCrop2x2:mode==='crop_2x2',n:mode==='standard'?(template.n ?? 1):1,detailInsetRatio:template.detailInsetRatio ?? 1/64};
  }
  // Field IDs belong to a concrete table: never silently target another attachment column.
  function resolveTemplateOutput(template, currentTableId, fieldIds) {
    if (!template?.outputFieldId) return {status:'unbound',fieldId:''};
    if (template.outputTableId && template.outputTableId !== currentTableId) return {status:'wrong_table',fieldId:''};
    if (!fieldIds.includes(template.outputFieldId)) return {status:'missing',fieldId:''};
    return {status:'ok',fieldId:template.outputFieldId};
  }
  function validateTemplate(t) {
    if(!t || typeof t.id!=='string' || typeof t.name!=='string' || typeof t.prompt!=='string') throw Error('模板数据格式不正确');
    // Validate layouts when editing/running the selected template, so legacy drafts
    // cannot prevent renaming or saving an unrelated template.
    rules.validate(t.size,t.n);
    return t;
  }
  function loadTemplates(storage) {
    const saved=storage.getItem(TEMPLATE_KEY), templates=saved===null?defaults():JSON.parse(saved);
    if(!Array.isArray(templates))throw Error('模板数据格式不正确');
    return templates.map(normalizeTemplate).map(validateTemplate);
  }
  function saveTemplates(storage, templates) {
    const normalized=templates.map(normalizeTemplate).map(validateTemplate);
    normalized.forEach(t=>{if(!t.name.trim() || t.name.length>100)throw Error('模板名称须为1～100个字符');});
    storage.setItem(TEMPLATE_KEY,JSON.stringify(normalized));
  }
  let database;
  function openDB() {
    if (!database) database = new Promise((resolve,reject) => {
      const r = indexedDB.open('ai-filler-brand-images',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('slots');
      r.onsuccess=()=>resolve(r.result); r.onerror=()=>{database=null;reject(Error('浏览器不允许保存品牌图，请检查存储权限'));};
    });
    return database;
  }
  async function slot(action, index, value) {
    const db = await openDB();
    return new Promise((resolve,reject) => {
      let tx;
      try { tx=db.transaction('slots',action==='get'?'readonly':'readwrite'); } catch { return reject(Error('品牌图保存失败，请检查浏览器存储权限；旧图片未替换')); }
      const store=tx.objectStore('slots');
      let r;
      try { r=action==='put'?store.put(value,index):action==='delete'?store.delete(index):store.get(index); }
      catch { return reject(Error('品牌图保存失败，请检查浏览器存储空间；旧图片未替换')); }
      tx.oncomplete=()=>resolve(r.result); tx.onabort=tx.onerror=()=>reject(Error('品牌图保存失败，请检查浏览器存储空间；旧图片未替换'));
    });
  }
  async function init({$, cfg, saveCfg, onError, getTableId = () => null}) {
    let templates;
    try { templates=loadTemplates(localStorage); } catch { templates=[];onError('模板读取失败；为避免覆盖旧数据，请先检查浏览器存储'); }
    const setError=message=>{ $('imageError').textContent=message; };
    const show=fn=>{try {fn();setError('');saveCfg();}catch(e){setError(e.name==='QuotaExceededError'?'浏览器存储空间不足，模板未保存，请清理空间后重试':e.message);} };
    const select=$('templateSelect');
    const drawTemplates=(id='')=>{
      select.replaceChildren(new Option('新建模板', ''));
      templates.forEach(t=>select.add(new Option(t.name,t.id)));select.value=id;
      $('templateName').value=templates.find(t=>t.id===id)?.name || '';
    };
    drawTemplates(cfg.imageTemplate ?? '');
    const outputSelect=$('outputSel'), outputHint=$('templateOutputHint');
    const restoreOutputForTable=()=>{
      const t=templates.find(v=>v.id===select.value);
      if (!getTableId() || !outputSelect.options.length) return;
      const validFieldIds=[...outputSelect.options].map(o=>o.value).filter(Boolean);
      const mapping=resolveTemplateOutput(t,getTableId(),validFieldIds);
      outputHint.classList.toggle('warn', mapping.status==='wrong_table'||mapping.status==='missing');
      if (mapping.status==='ok') {
        outputSelect.value=mapping.fieldId;
        outputHint.textContent='模板已绑定输出列：'+outputSelect.selectedOptions[0].textContent;
      } else if (t) {
        outputSelect.value='';
        outputHint.textContent=mapping.status==='unbound'
          ? '此模板尚未保存输出列：请选择附件列并点击「保存模板」。'
          : '原绑定附件列不在当前数据表中；请重新选择并保存，避免误写。';
      } else {
        outputHint.textContent='新建模板：请选输出附件列，再与Prompt一起保存。';
      }
    };
    outputSelect.addEventListener('change',()=>{
      const t=templates.find(v=>v.id===select.value);
      if (t) {
        const alreadySaved=t.outputFieldId===outputSelect.value && (!t.outputTableId || t.outputTableId===getTableId());
        outputHint.classList.remove('warn');
        outputHint.textContent=alreadySaved?'当前输出列已保存到模板。':'已调整输出列；请点击「保存模板」以便切换后自动恢复。';
      }
    });
    const crop=$('autoCrop2x2'), count=$('imageCount'), mode=$('generationMode'), detailInset=$('detailInsetRatio');
    const selected=templates.find(t=>t.id===select.value);
    mode.value=rules.generationMode(cfg.generationMode ?? (cfg.autoCrop2x2===undefined?selected?.generationMode:undefined),cfg.autoCrop2x2);
    crop.dataset.normalCount=String((mode.value==='standard'?cfg.imageCount:cfg.imageCountBeforeCrop) || cfg.imageCount || 1);
    const setInset=value=>{const text=String(value);if(![...detailInset.options].some(o=>o.value===text))detailInset.add(new Option('已保存内缩比例 '+text,text));detailInset.value=text;};
    setInset(cfg.detailInsetRatio ?? selected?.detailInsetRatio ?? 1/64);
    const sync=()=>{
      crop.checked=mode.value==='crop_2x2';count.disabled=mode.value!=='standard';
      count.value=count.disabled?'1':crop.dataset.normalCount;
      $('standardCount').hidden=count.disabled;$('detailInsetRow').hidden=mode.value!=='crop_3x1';
      $('generationSummary').textContent={crop_2x2:'1次API生成 → 自动裁切4张方图',crop_3x1:'1次API生成 → 自动裁切3张9:16竖图',standard:'标准图片生成，可选择1～10张'}[mode.value];
    };
    const setCount=value=>{if(mode.value==='standard')crop.dataset.normalCount=String(value);sync();};
    sync();
    // Retained hidden legacy node remains a working alias for older integrations.
    crop.onchange=()=>{mode.value=crop.checked?'crop_2x2':'standard';sync();validate();saveCfg();};
    mode.onchange=()=>{sync();validate();saveCfg();};
    detailInset.onchange=()=>{validate();saveCfg();};
    $('imageWidth').value=cfg.imageWidth ?? (cfg.imgSize && cfg.imgSize!=='custom'?cfg.imgSize:'1024x1024').split('x')[0];
    $('imageHeight').value=cfg.imageHeight ?? (cfg.imgSize && cfg.imgSize!=='custom'?cfg.imgSize:'1024x1024').split('x')[1];
    if(!cfg.imgSize)$('imgSize').value='1024x1024';
    const current=()=>rules.generationOptions($('imageWidth').value+'x'+$('imageHeight').value,count.value,mode.value,Number(detailInset.value));
    function validate(){try{current();setError('');return true;}catch(e){setError(e.message);return false;}}
    select.onchange=()=>show(()=>{
      const t=templates.find(t=>t.id===select.value);$('templateName').value=t?.name || '';
      if(t){
        $('prompt').value=t.prompt;mode.value=t.generationMode;setInset(t.detailInsetRatio);setCount(t.n);
        const [w,h]=t.size.split('x');$('imageWidth').value=w;$('imageHeight').value=h;
        $('imgSize').value=[...$('imgSize').options].some(o=>o.value===t.size)?t.size:'custom';
      }
      restoreOutputForTable();
    });
    select.addEventListener('change',validate);
    $('saveTemplate').onclick=()=>show(()=>{
      const v=current(),name=$('templateName').value.trim();if(!name)throw Error('请填写模板名称');
      if (!getTableId() || !outputSelect.value || ![...outputSelect.options].some(o=>o.value===outputSelect.value && o.value)) throw Error('请选择当前飞书表的输出附件列，然后再保存模板');
      const t={...templates.find(t=>t.id===select.value),id:select.value || crypto.randomUUID(),name,prompt:$('prompt').value,n:v.n,size:v.size,generationMode:v.generationMode,autoCrop2x2:v.autoCrop2x2,detailInsetRatio:v.detailInsetRatio,outputFieldId:outputSelect.value,outputTableId:getTableId()};
      const next=templates.some(x=>x.id===t.id)?templates.map(x=>x.id===t.id?t:x):[...templates,t];
      saveTemplates(localStorage,next);templates=next;drawTemplates(t.id);restoreOutputForTable();
    });
    $('renameTemplate').onclick=()=>show(()=>{
      if(!select.value)throw Error('请先选择要重命名的模板');
      const id=select.value,next=templates.map(t=>t.id===id?{...t,name:$('templateName').value.trim()}:t);
      saveTemplates(localStorage,next);templates=next;drawTemplates(id);
    });
    $('deleteTemplate').onclick=()=>show(()=>{
      if(!select.value)throw Error('请先选择要删除的模板');
      const next=templates.filter(t=>t.id!==select.value);saveTemplates(localStorage,next);templates=next;drawTemplates();
    });
    $('imgSize').addEventListener('change',()=>{if($('imgSize').value!=='custom'){const [w,h]=$('imgSize').value.split('x');$('imageWidth').value=w;$('imageHeight').value=h;}validate();saveCfg();});
    ['imageWidth','imageHeight','imageCount'].forEach(id=>$(id).addEventListener('input',()=>{if(id!=='imageCount')$('imgSize').value='custom';else if(mode.value!=='standard')count.value='1';else crop.dataset.normalCount=count.value;validate();saveCfg();}));
    const brandImages=Array(4).fill(null), previews=Array(4).fill(null); let pending=0, storageReady=true;
    const drawSlot=(index,blob)=>{
      if(previews[index])URL.revokeObjectURL(previews[index]);
      const image=$('brandPreview'+index);previews[index]=blob?URL.createObjectURL(blob):null;image.src=previews[index] || '';image.hidden=!blob;
      brandImages[index]=blob;
    };
    for(let i=0;i<4;i++){
      const box=document.createElement('div');
      const label=document.createElement('label');label.htmlFor='brandFile'+i;label.textContent='品牌参考图 '+(i+1);box.append(label);
      const image=document.createElement('img');image.id='brandPreview'+i;image.alt='品牌参考图 '+(i+1);image.hidden=true;image.style.cssText='max-width:120px;max-height:100px';box.append(image);
      const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.id='brandFile'+i;box.append(input);
      const remove=document.createElement('button');remove.type='button';remove.textContent='删除';remove.id='brandDelete'+i;box.append(remove);$('brandSlots').append(box);
      try{drawSlot(i,await slot('get',i));}catch(e){storageReady=false;onError(e.message);}
      input.onchange=async()=>{
        const file=input.files[0];if(!file)return;pending++;input.disabled=remove.disabled=true;
        try{await root.ImageAPI.imageBlob(new Response(file,{headers:{'Content-Type':file.type}}));await slot('put',i,file);drawSlot(i,file);setError('');}
        catch(e){setError(e.message);}finally{pending--;input.disabled=remove.disabled=false;input.value='';}
      };
      remove.onclick=async()=>{pending++;input.disabled=remove.disabled=true;try{await slot('delete',i);drawSlot(i,null);setError('');}catch(e){setError(e.message);}finally{pending--;input.disabled=remove.disabled=false;}};
    }
    const originals=[];
    $('clearCropOriginals').onclick=()=>{originals.forEach(url=>URL.revokeObjectURL(url));originals.length=0;$('cropOriginalLinks').replaceChildren();$('cropOriginals').hidden=true;};
    const keepOriginal=(blob,rid)=>{
      const url=URL.createObjectURL(blob);originals.push(url);
      const link=document.createElement('a');link.href=url;link.download='拼版原图_'+rid.slice(-6)+'_'+Date.now()+'.'+({'image/jpeg':'jpg','image/webp':'webp'}[blob.type] || 'png');
      link.textContent='下载拼版原图（行 '+rid.slice(-6)+'）';link.style.display='block';
      $('cropOriginalLinks').append(link);$('cropOriginals').hidden=false;
    };
    return {
      keepOriginal,
      validate,
      restoreOutputForTable,
      snapshot:()=>{if(pending)throw Error('品牌图正在保存，请稍后生成');if(!storageReady)throw Error('品牌图读取失败，已停止生成以免遗漏参考图；请恢复浏览器存储权限后刷新');const value=current();if(value.generationMode!=='standard')root.ImageAPI.checkCropSupport();return {...value,promptTemplate:$('prompt').value,brandImages:brandImages.filter(Boolean)};}
    };
  }
  const api={defaults,normalizeTemplate,resolveTemplateOutput,loadTemplates,saveTemplates,TEMPLATE_KEY,init};
  if(typeof module!=='undefined')module.exports=api;else root.ImageOptions=api;
})(globalThis);
