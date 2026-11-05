/* Local-only templates and four reference slots. No API keys are stored here. */
(function(root) {
  const rules = typeof module !== 'undefined' ? require('./server/image-rules.js') : root.ImageRules;
  const TEMPLATE_KEY = 'ai-filler-image-templates-v1';
  function defaults() { return [
    {id:'main', name:'主图模板', prompt:'以第一张商品白底图为商品主体，后续图片仅作为品牌风格参考。保持商品外形、颜色、商标及包装文字，生成简洁真实的电商主图场景，不添加水印。', n:4, size:'1024x1024'},
    {id:'detail', name:'详情页模板', prompt:'以第一张商品白底图为商品主体，后续图片仅作为品牌风格参考。保持商品一致，生成展示产品细节与使用场景的电商详情页图片，不虚构产品功能，不添加水印。', n:3, size:'1024x1536'}
  ]; }
  function loadTemplates(storage) {
    const saved = storage.getItem(TEMPLATE_KEY);
    const templates = saved === null ? defaults() : JSON.parse(saved);
    if (!Array.isArray(templates) || templates.some(t=>!t || typeof t.id!=='string' || typeof t.name!=='string' || typeof t.prompt!=='string')) throw Error('模板数据格式不正确');
    templates.forEach(t=>rules.validate(t.size,t.n));
    return templates;
  }
  function saveTemplates(storage, templates) {
    templates.forEach(t => { if (!t.name.trim() || t.name.length > 100) throw Error('模板名称须为 1～100 个字符'); rules.validate(t.size,t.n); });
    storage.setItem(TEMPLATE_KEY, JSON.stringify(templates));
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
  async function init({$, cfg, saveCfg, onError}) {
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
    const crop=$('autoCrop2x2'), count=$('imageCount');
    crop.checked=cfg.autoCrop2x2 === true;
    crop.dataset.normalCount=String((crop.checked ? cfg.imageCountBeforeCrop : cfg.imageCount) || cfg.imageCount || 4);
    const setCount=value=>{crop.dataset.normalCount=String(value);count.value=crop.checked?'1':String(value);count.disabled=crop.checked;};
    setCount(crop.dataset.normalCount);
    crop.onchange=()=>{
      if(crop.checked){crop.dataset.normalCount=count.value;count.value='1';count.disabled=true;}
      else {count.disabled=false;count.value=crop.dataset.normalCount || '4';}
      validate();saveCfg();
    };
    $('imageWidth').value=cfg.imageWidth ?? (cfg.imgSize || '1024x1024').split('x')[0];
    $('imageHeight').value=cfg.imageHeight ?? (cfg.imgSize || '1024x1024').split('x')[1];
    if (!cfg.imgSize) $('imgSize').value='1024x1024';
    if (cfg.imgSize==='custom') { $('imageWidth').value=cfg.imageWidth || 1024; $('imageHeight').value=cfg.imageHeight || 1024; }
    const current=()=>{
      const value=rules.checkResultBudget($('imageWidth').value+'x'+$('imageHeight').value,crop.checked?1:count.value);
      if(crop.checked && value.width!==value.height)throw Error('自动裁切模式只接受正方形图片，请将宽高设为相同值，建议2880×2880');
      return {...value,autoCrop2x2:crop.checked};
    };
    function validate() {try{current();setError('');return true;}catch(e){setError(e.message);return false;}}
    select.onchange=()=>show(()=>{
      const t=templates.find(t=>t.id===select.value);$('templateName').value=t?.name || '';
      if(t){$('prompt').value=t.prompt;setCount(t.n);const [w,h]=t.size.split('x');$('imageWidth').value=w;$('imageHeight').value=h;$('imgSize').value=[...$('imgSize').options].some(o=>o.value===t.size)?t.size:'custom';}
    });
    select.addEventListener('change',validate);
    $('saveTemplate').onclick=()=>show(()=>{
      const v=current(), name=$('templateName').value.trim();if(!name)throw Error('请填写模板名称');
      const t={id:select.value || crypto.randomUUID(),name,prompt:$('prompt').value,n:v.n,size:v.size};
      const next=templates.some(x=>x.id===t.id)?templates.map(x=>x.id===t.id?t:x):[...templates,t];
      saveTemplates(localStorage,next);templates=next;drawTemplates(t.id);
    });
    $('renameTemplate').onclick=()=>show(()=>{
      if(!select.value)throw Error('请先选择要重命名的模板');
      const id=select.value;const next=templates.map(t=>t.id===id?{...t,name:$('templateName').value.trim()}:t);
      saveTemplates(localStorage,next);templates=next;drawTemplates(id);
    });
    $('deleteTemplate').onclick=()=>show(()=>{
      if(!select.value)throw Error('请先选择要删除的模板');
      const next=templates.filter(t=>t.id!==select.value);saveTemplates(localStorage,next);templates=next;drawTemplates();
    });
    $('imgSize').addEventListener('change',()=>{if($('imgSize').value!=='custom'){const [w,h]=$('imgSize').value.split('x');$('imageWidth').value=w;$('imageHeight').value=h;}validate();saveCfg();});
    ['imageWidth','imageHeight','imageCount'].forEach(id=>$(id).addEventListener('input',()=>{if(id!=='imageCount')$('imgSize').value='custom';else if(crop.checked)count.value='1';else crop.dataset.normalCount=count.value;validate();saveCfg();}));
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
      snapshot:()=>{if(pending)throw Error('品牌图正在保存，请稍后生成');if(!storageReady)throw Error('品牌图读取失败，已停止生成以免遗漏参考图；请恢复浏览器存储权限后刷新');const value=current();if(value.autoCrop2x2)root.ImageAPI.checkCropSupport();return {...value,brandImages:brandImages.filter(Boolean)};}
    };
  }
  const api={defaults,loadTemplates,saveTemplates,TEMPLATE_KEY,init};
  if(typeof module!=='undefined')module.exports=api;else root.ImageOptions=api;
})(globalThis);
