/* Local recovery for generated collages and their original Feishu destinations. */
(function (root) {
  function openRecoveryDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ai-filler-image-recovery', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('jobs', {keyPath:'id'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('恢复存储被其他页面占用'));
    });
  }

  function transaction(db, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('jobs', mode);
      const request = action(tx.objectStore('jobs'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error || request.error);
    });
  }

  async function init({$, runRecovery, log}) {
    const panel = $('cropOriginals');
    const list = $('cropOriginalLinks');
    const clear = $('clearCropOriginals');
    const items = new Map();
    let db, stored = [];
    try {
      db = await openRecoveryDB();
      stored = await transaction(db, 'readonly', store => store.getAll());
    } catch {
      log('图片恢复存储不可用。生成的图片会保留在当前面板，请在关闭前下载。', true);
    }

    function setVisibility() {
      panel.hidden = items.size === 0;
      clear.hidden = ![...items.values()].some(item => item.status === 'done');
    }

    function download(blob, name, label) {
      const link = document.createElement('a');
      link.href = '#';
      link.download = name;
      link.textContent = label;
      link.style.display = 'block';
      link.onclick = event => {
        try {
          const url = URL.createObjectURL(blob);
          link.href = url;
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch {
          event.preventDefault();
          log('无法创建图片下载链接，请重试。图片仍保留在恢复记录中。', true);
        }
      };
      return link;
    }

    function render(item) {
      const {job, status, element} = item;
      const label = job.sku ? `SKU ${job.sku}` : `行 ${job.rid.slice(-6)}`;
      const title = document.createElement('p');
      const states = {working:'处理中', failed:'可恢复', done:'已回写'};
      title.textContent = `${label} · ${job.fieldName || job.fid} · ${states[status]}`;
      element.replaceChildren(title);
      job.originals.forEach((blob, i) => {
        const extension = {'image/jpeg':'jpg', 'image/webp':'webp'}[blob.type] || 'png';
        element.append(download(blob, `拼版原图_${job.rid.slice(-6)}_${job.id}_${i+1}.${extension}`, '下载拼版原图'));
      });
      if (status !== 'failed') return;
      job.crops.forEach((file, i) => element.append(download(file, file.name, `下载裁切图 ${i+1}`)));
      for (const [action, text, enabled] of [
        ['crop', '重新裁切', job.originals.length === 1],
        ['write', '重新上传并回写飞书', job.cropComplete]
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.disabled = !enabled;
        button.onclick = () => runRecovery(job, action);
        element.append(button);
      }
    }

    function update(job, status) {
      let item = items.get(job.id);
      if (!item) {
        const element = document.createElement('section');
        element.className = 'crop-recovery-item';
        item = {job, element};
        items.set(job.id, item);
        list.append(element);
      }
      item.status = status;
      render(item);
      setVisibility();
    }

    clear.onclick = () => {
      for (const [id, item] of items) {
        if (item.status !== 'done') continue;
        item.element.remove();
        items.delete(id);
      }
      setVisibility();
    };
    for (const job of stored) update(job, 'failed');

    return {
      checkpoint: async job => {
        // Persist the image bytes before rendering any download controls.
        try {
          if (!db) throw Error('无法保存到浏览器，图片保留在当前面板');
          await transaction(db, 'readwrite', store => store.put(job));
        } finally {
          update(job, 'working');
        }
      },
      failed: job => { if (job.originals?.length) update(job, 'failed'); },
      complete: async job => {
        try {
          if (db) await transaction(db, 'readwrite', store => store.delete(job.id));
        } catch { log('图片已回写。浏览器未能清除恢复记录。', true); }
        job.crops = [];
        job.attachments = [];
        update(job, 'done');
      }
    };
  }
  root.ImageRecovery = {init};
})(globalThis);
