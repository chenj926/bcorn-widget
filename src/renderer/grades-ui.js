/* Independent assessment notebook. Never mutates the ACORN transcript or timetable cache. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/grade-book'));
  else root.GradesUI = factory(root.GradeBook);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Grades) {
  'use strict';
  const KEY = 'bcorn.private.gradebook.v1';
  const MAX_BYTES = 2 * 1024 * 1024;
  const emptyBook = () => ({ schemaVersion: 1, courses: [] });
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const percentage = value => value === null ? '尚无已出分项目' : (value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + '%';
  const scoreText = score => !score ? '' : score.mode === 'points' ? `${score.earned}/${score.possible}` : `${Number((score.value * 100).toPrecision(12))}%`;
  function id() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'grade-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  function checkedBook(value) {
    if (value === null || value === undefined) return emptyBook();
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('成绩记录超过 2 MiB；原数据未被覆盖。');
    const check = Grades.validateBook(value);
    if (!check.ok) throw new Error('成绩记录格式或版本不受支持；原数据未被覆盖。');
    return Grades.normalizeBook(value);
  }
  function createStorage(bridge, storage) {
    const native = bridge && typeof bridge.loadGradeBook === 'function' && typeof bridge.saveGradeBook === 'function';
    return {
      kind: native ? 'native' : 'browser-local',
      async load() {
        if (native) return checkedBook(await bridge.loadGradeBook());
        if (!storage) throw new Error('此页面没有可用的本机成绩存储。');
        const text = storage.getItem(KEY);
        if (!text) return emptyBook();
        let value; try { value = JSON.parse(text); } catch (_) { throw new Error('本机成绩文件损坏；原数据未被覆盖。'); }
        return checkedBook(value);
      },
      async save(book) {
        const value = checkedBook(book);
        if (native) {
          const result = await bridge.saveGradeBook(value);
          if (!result || result.ok !== true) throw new Error('本机保存没有确认成功；请重试。');
        } else {
          if (!storage) throw new Error('此页面没有可用的本机成绩存储。');
          storage.setItem(KEY, JSON.stringify(value));
        }
        return value;
      }
    };
  }
  let selectedCourse = null, activeMount = null;
  const mounts = new WeakMap();
  async function mount(container, options) {
    if (!container) return;
    options = options || {};
    if (mounts.has(container)) return mounts.get(container);
    if (activeMount && activeMount.unsubscribe) activeMount.unsubscribe();
    const token = { active: true, dirty: false }; activeMount = token; mounts.set(container, token);
    let browserStorage;
    try { browserStorage = typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { browserStorage = null; }
    const storage = createStorage(options.bridge, options.storage || browserStorage);
    let book, message = '', busy = false, syncSession = null, syncState = { status: 'not-configured', automaticInbound: false }, pendingRemoteBook = null;
    container.classList.add('grade-book');
    container.innerHTML = '<p class="gb-muted" role="status">正在读取本机作业成绩…</p>';
    function current() { return book.courses.find(course => course.id === selectedCourse) || book.courses[0]; }
    function assessmentForm(a, isNew) {
      return `<form class="gb-assessment-form" data-gb-form="assessment" data-id="${escape(isNew ? '' : a.id)}">
        <label>项目名称<input name="title" required maxlength="1000" value="${escape(a.title)}" placeholder="作业、测验或考试"></label>
        <label>总评权重 (%)<input name="weight" type="number" required min="0" max="100" step="any" inputmode="decimal" value="${isNew ? '' : Number((a.weight * 100).toPrecision(12))}" placeholder="例如 10"></label>
        <label>状态<select name="status"><option value="ungraded" ${a.status === 'ungraded' ? 'selected' : ''}>未出分</option><option value="graded" ${a.status === 'graded' ? 'selected' : ''}>已出分（包括 0 分）</option><option value="exempt" ${a.status === 'exempt' ? 'selected' : ''}>豁免（需确认权重）</option></select></label>
        <label>所得成绩<input name="score" inputmode="text" value="${escape(scoreText(a.score))}" placeholder="80%、0.8 或 40.5/50" aria-describedby="gb-input-help"></label>
        <div class="gb-form-actions"><button type="submit">${isNew ? '添加项目' : '保存项目'}</button>${isNew ? '' : `<button type="button" class="gb-remove" data-gb-action="delete-assessment" data-id="${escape(a.id)}">删除</button>`}</div>
      </form>`;
    }
    function syncLabel() {
      const labels = { 'not-configured': '云同步未配置', 'authorization-required': '需要重新授权 Google', 'relink-required': '请重新确认 Google 同步目标', revoked: 'Google 授权已撤销', connecting: '正在连接 Google…', syncing: '正在双向同步…', pending: '本机有待同步修改', offline: '离线，修改保留在本机', conflict: '同步冲突：请处理不同版本', error: '同步暂未成功，修改仍在本机', ready: 'Google 已连接', synced: '已同步' };
      if (syncState.paused) return '自动同步已暂停 · 修改仅保存在本机，Google 授权仍保留';
      let label = labels[syncState.status] || '同步需要检查';
      if (['ready', 'synced'].includes(syncState.status)) label += syncState.foregroundAuto ? ' · 打开应用时自动双向同步' : ' · 自动同步尚未启动';
      return label;
    }
    function conflictDescription(value) {
      if (value === undefined) return '该行不再可见';
      if (value === null) return '已删除';
      if (value.kind === 'course') return `${value.title} · ${value.termId || ''} · ${value.rule === 'weighted' ? '普通加权' : '规则待确认'}`;
      return `${value.title || ''} · 权重 ${percentage(value.weight || 0)} · ${value.status === 'graded' ? scoreText(value.score) : value.status === 'exempt' ? '豁免' : '未出分'}`;
    }
    function render() {
      if (!token.active || !container.isConnected) return;
      const course = current(); if (course) selectedCourse = course.id;
      const calculated = course ? Grades.calculateCourse(course) : null;
      const m = calculated && calculated.metrics;
      container.innerHTML = `<header class="gb-header"><div><h2>作业成绩</h2><p class="gb-muted">独立记录课程内评分；下方原成绩单保持不变。</p></div><span class="gb-badge">本机记录</span></header>
        <p class="gb-sync-state" role="status">${escape(syncLabel())} · ${storage.kind === 'native' ? '保存到本机独立成绩文件' : '网页预览：仅此浏览器本地保存'}</p>
        ${course && syncSession && syncSession.canCreateMapped ? '<button type="button" data-gb-action="create-mapped">为当前课程新建易读成绩表</button>' : ''}
        ${syncSession && syncSession.canMap ? '<button type="button" data-gb-action="map-existing">连接现有 Google Sheet</button>' : ''}
        ${syncSession && syncSession.service ? `<button type="button" data-gb-action="toggle-sync">${syncState.paused ? '恢复自动同步' : '暂停自动同步'}</button>` : ''}
        ${syncSession && syncSession.canConnect && ['not-configured', 'authorization-required', 'revoked'].includes(syncState.status) ? '<button type="button" data-gb-action="connect">连接 Google 并新建成绩表</button><p class="gb-muted">将在你的 Drive 新建独立表，不修改已有表。</p>' : ''}<details class="gb-sync-help"><summary>自动双向同步说明</summary><p>连接 Google 并明确确认工作表后，应用打开且联网时自动双向同步：本机修改立即排队写回，表格修改约 15–120 秒内自动读取（另加网络耗时）。隐藏、后台或离线时暂停检查，下次打开或恢复网络自动补齐，不需要手动刷新，也不需要常驻服务器。${['not-configured', 'authorization-required', 'revoked'].includes(syncState.status) ? '当前未连接，不会读取或修改任何 Google 表格。' : '仅同步明确确认的文件和工作表；已有模板仅写映射的成绩和权重。'}离线与系统限制会延迟同步。</p></details>
        <p class="gb-message" role="status" aria-live="polite">${escape(message)}</p>
        ${Object.entries(syncState.conflicts || {}).map(([conflictId, conflict]) => `<details class="gb-conflict"><summary>同步冲突：${escape((conflict.local || conflict.remote || {}).title || '已修改项目')}</summary><p>本机：${escape(conflictDescription(conflict.local))}</p><p>表格：${escape(conflictDescription(conflict.remote))}</p>${conflict.code === 'remote-missing' ? '<p>远端行缺失，请先在专用成绩表恢复该行或检查绑定；不会自动重建。</p>' : `<div class="gb-form-actions"><button type="button" data-gb-action="resolve-local" data-id="${escape(conflictId)}">保留本机版本</button><button type="button" data-gb-action="resolve-remote" data-id="${escape(conflictId)}">采用表格版本</button></div>`}</details>`).join('')}

        ${book.courses.length ? `<label class="gb-course-picker">课程<select data-gb-action="select-course">${book.courses.map(c => `<option value="${escape(c.id)}" ${c.id === selectedCourse ? 'selected' : ''}>${escape(c.title || c.id)}${c.termId ? ' · ' + escape(c.termId) : ''}</option>`).join('')}</select></label>` : '<p class="gb-empty">先根据课程大纲新建课程，再填每个项目的权重。</p>'}
        <details class="gb-new-course"><summary>＋ 新建课程评分表</summary><form data-gb-form="course"><label>课程名称<input name="title" required maxlength="200" placeholder="例如：示例课程"></label><label>学期（可选）<input name="termId" maxlength="200" placeholder="例如：2026 秋季"></label><label class="gb-checkbox"><input name="ordinary" type="checkbox">已核对大纲，使用普通加权计算（无最低分舍弃、额外加分或替换规则）</label><button type="submit">创建本机评分表</button></form></details>
        ${course ? `<div class="gb-metrics"><div><span>已出分均分</span><strong>${percentage(m.currentAverage)}</strong></div><div><span>已获得总评贡献</span><strong>${(m.earnedContribution * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 个百分点</strong></div><div><span>待评分权重</span><strong>${percentage(m.pendingWeight)}</strong></div></div>
        <p class="gb-muted">已评分权重 ${percentage(m.gradedWeight)} · 已录总权重 ${percentage(m.totalWeight)}${m.maximumFinal !== null ? ' · 最高可达总评 ' + percentage(m.maximumFinal) : ''}</p>
        ${calculated.warnings.length ? `<div class="gb-warning" role="note">${calculated.warnings.map(w => w.code === 'incomplete-weights' ? '权重尚未合计 100%；不会自动归一化，最终分预测暂不可用。' : w.code === 'exemption-rule-required' ? '存在豁免项目，请按大纲明确调整其权重。' : '尚未确认普通加权规则。最低分舍弃、额外加分、替换评分需按大纲单独处理；当前指标仅为普通加权试算。').map(escape).join('<br>')}</div>` : ''}
        <form data-gb-form="rules" class="gb-rule-form"><label class="gb-checkbox"><input name="ordinary" type="checkbox" ${course.rules && course.rules.kind === 'weighted' ? 'checked' : ''}>已确认此课程采用普通加权评分</label><button type="submit">保存规则确认</button></form>
        <p id="gb-input-help" class="gb-muted">支持小数、百分比与得分/满分。真正的 0 分请选“已出分”；未知成绩保持“未出分”。输入成绩时请选择“已出分”。</p>
        <div class="gb-assessments">${course.assessments.map(a => `<details class="gb-assessment"><summary><span>${escape(a.title)}</span><span>${percentage(a.weight)} · ${a.status === 'graded' ? escape(scoreText(a.score)) : a.status === 'exempt' ? '豁免' : '未出分'}</span></summary>${assessmentForm(a, false)}</details>`).join('')}</div>
        <details class="gb-add-assessment"><summary>＋ 添加评分项目</summary>${assessmentForm({ title: '', status: 'ungraded', score: null }, true)}</details>` : ''}`;
      container.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    }
    async function save(next) {
      busy = true;
      try { const saved = syncSession && syncSession.service ? await syncSession.service.saveBook(next) : await storage.save(next); book = saved; token.dirty = false; message = '已保存到本机。'; render(); }
      finally { busy = false; container.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    }
    container.addEventListener('input', event => { if (event.target.closest('[data-gb-form]')) token.dirty = true; });
    container.addEventListener('change', event => {
      if (event.target.closest('[data-gb-form]')) token.dirty = true;
      if (event.target.matches('[data-gb-action="select-course"]')) { if (!confirmLeave()) { event.target.value = selectedCourse; return; } selectedCourse = event.target.value; message = ''; render(); }
    });
    container.addEventListener('click', async event => {
      const resolution = event.target.closest('[data-gb-action="resolve-local"], [data-gb-action="resolve-remote"]');
      if (resolution && syncSession && syncSession.service && !busy) {
        if (token.dirty) { message = '请先保存或放弃当前输入，再处理同步冲突。'; container.querySelector('.gb-message').textContent = message; return; }
        const conflict = (syncState.conflicts || {})[resolution.dataset.id]; if (!conflict) return;
        busy = true;
        try { await syncSession.service.resolve(resolution.dataset.id, resolution.dataset.gbAction === 'resolve-local' ? conflict.local : conflict.remote); message = '已提交所选版本，正在核对同步结果。'; }
        catch (_) { message = '冲突尚未解决；两个版本仍保留。'; }
        finally { busy = false; render(); }
        return;
      }
      const toggleSync = event.target.closest('[data-gb-action="toggle-sync"]');
      if (toggleSync && syncSession && !busy) { try { await syncSession.setPaused(!syncState.paused); message = syncState.paused ? '同步已暂停；成绩和待同步修改仍保留。' : '自动同步已恢复。'; } catch (error) { message = error.message; } render(); return; }
      const createMapped=event.target.closest('[data-gb-action="create-mapped"]');
      if(createMapped&&syncSession&&!busy){if(!confirmLeave())return;const course=current();if(!course||!course.assessments.length){message='请先按课程大纲添加考核项目和权重。';render();return;}if(!window.confirm('在你的 Google Drive 为“'+course.title+'”新建易读成绩表，并写入当前已录入的考核、权重和成绩？创建后此课程在前台自动双向同步。'))return;busy=true;try{await syncSession.createMapped(course);message='已创建易读成绩表并连接当前课程。';}catch(error){message=error.message;}finally{busy=false;render();}return;}
      const mapExisting = event.target.closest('[data-gb-action="map-existing"]');
      if (mapExisting && syncSession && !busy) {
        if (!confirmLeave()) return;
        if (!window.SheetMappingUI) { message='此版本尚未加载成绩映射界面。';render();return; }
        const dialog=document.createElement('dialog');dialog.className='gb-mapping-dialog';
        const close=document.createElement('button');close.type='button';close.textContent='关闭';dialog.append(close);document.body.append(dialog);
        let mappingUI;
        const finish=()=>{if(mappingUI)mappingUI.dispose();dialog.remove();};
        close.onclick=finish;dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});
        mappingUI=window.SheetMappingUI.mount(dialog,{bridge:{
          async pickGradeSheet(args){await syncSession.prepareMapping();return window.GradeSyncClient.nativeCall(options.bridge,'pickGradeSheet',args);},
          previewGradeSheet:args=>window.GradeSyncClient.nativeCall(options.bridge,'previewGradeSheet',args)
        },onConfirm:async payload=>{
          const latest=await storage.load();const collisions=payload.book.courses.filter(c=>latest.courses.some(x=>x.id===c.id));
          const detail=collisions.length?'同标识本机课程将替换为此预览：'+collisions.map(c=>c.title).join('、')+'。':'将导入 '+payload.book.courses.length+' 门映射课程。';
          if(!window.confirm(detail+'其他本机课程保留。确认连接后，映射成绩和权重将在前台自动双向同步；请避免同时编辑相同单元格。继续？'))throw new Error('未确认导入；未修改本机或表格成绩。');
          await syncSession.confirmMapping(payload);book=await storage.load();message='已连接映射成绩表，其他本机课程已保留。';finish();render();
        }});
        if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
        return;
      }
      const connect = event.target.closest('[data-gb-action="connect"]');
      if (connect && syncSession && !busy) { busy = true; connect.disabled = true; try { await syncSession.connect(); message = '连接状态已更新。'; } catch (error) { message = error.message; } finally { busy = false; render(); } return; }
      const reload = event.target.closest('[data-gb-action="reload-remote"]');
      if (reload && pendingRemoteBook && confirmLeave()) { book = pendingRemoteBook; pendingRemoteBook = null; message = '已加载云端新版本。'; render(); return; }
      const button = event.target.closest('[data-gb-action="delete-assessment"]');
      if (!button || busy) return;
      if (typeof window !== 'undefined' && !window.confirm('删除此本机评分项目？这不会修改成绩单或 Google 表格。')) return;
      const next = clone(book), course = next.courses.find(c => c.id === current().id);
      course.assessments = course.assessments.filter(a => a.id !== button.dataset.id);
      try { await save(next); } catch (_) { message = '保存失败，原记录仍保留；请重试。'; render(); }
    });
    container.addEventListener('submit', async event => {
      const form = event.target.closest('[data-gb-form]'); if (!form) return; event.preventDefault(); if (busy) return;
      if (pendingRemoteBook) { const target = container.querySelector('.gb-message'); if (target) target.textContent = '云端已有新版本；请先加载新版本再编辑，避免覆盖。'; return; }
      const data = new FormData(form), next = clone(book);
      try {
        if (form.dataset.gbForm === 'course') {
          const title = String(data.get('title') || '').trim(); if (!title) throw new Error('请填写课程名称。');
          const course = { id: id(), title, termId: String(data.get('termId') || '').trim(), rules: { kind: data.has('ordinary') ? 'weighted' : 'unconfirmed' }, assessments: [] };
          next.courses.push(course); selectedCourse = course.id;
        } else {
          const course = next.courses.find(c => c.id === current().id);
          if (form.dataset.gbForm === 'rules') course.rules = { kind: data.has('ordinary') ? 'weighted' : 'unconfirmed' };
          else {
            const title = String(data.get('title') || '').trim(), rawWeight = String(data.get('weight') || '').trim(), status = data.get('status');
            if (!title || rawWeight === '') throw new Error('请填写项目名称和权重。');
            const parsed = Grades.parseGradeInput(data.get('score'));
            if (!parsed.ok) throw new Error('成绩格式无效。请输入 80%、0.8 或 40.5/50；不支持公式或隐含加分。');
            if (status === 'graded' && !parsed.score) throw new Error('已出分项目需要成绩；0 分可以直接填写 0。');
            if (status !== 'graded' && parsed.score) throw new Error('已填写成绩，请将状态改为“已出分”；未出分/豁免请清空成绩。');
            const assessment = { id: form.dataset.id || id(), title, weight: Number(rawWeight) / 100, status, score: parsed.score };
            const index = course.assessments.findIndex(a => a.id === assessment.id);
            if (index < 0) course.assessments.push(assessment); else course.assessments[index] = assessment;
            const check = Grades.validateCourse(course); if (!check.ok) throw new Error('请检查权重范围（0–100%）和成绩格式。');
          }
        }
        await save(next);
      } catch (error) { message = error.message || '保存失败，请重试。'; const target = container.querySelector('.gb-message'); if (target) target.textContent = message; }
    });
    token.prepareImport=async()=>{if(syncSession)await syncSession.blockForImport();token.dirty=false;pendingRemoteBook=null;};
    token.reloadAfterImport=async()=>{book=await storage.load();token.dirty=false;pendingRemoteBook=null;message='已导入本机成绩。请重新确认云同步目标后再连接。';render();};
    try {
      book = await storage.load(); render();
      if (typeof window !== 'undefined' && window.GradeSyncClient) {
        syncSession = await window.GradeSyncClient.getSession(options.bridge, storage);
        if (syncSession) token.unsubscribe = syncSession.subscribe(state => {
          if (!container.isConnected) return;
          syncState = state;
          if (state.book && JSON.stringify(state.book) !== JSON.stringify(book)) {
            if (token.dirty) {
              pendingRemoteBook = state.book; message = '云端已有新版本，未保存输入已保留。';
              const text = container.querySelector('.gb-message'); if (text) text.textContent = message;
              if (!container.querySelector('[data-gb-action="reload-remote"]')) { const button = document.createElement('button'); button.type = 'button'; button.dataset.gbAction = 'reload-remote'; button.textContent = '加载新版本（放弃未保存输入）'; text.after(button); }
              return;
            }
            book = state.book;
          }
          if (!token.dirty) render();
          else { const label = container.querySelector('.gb-sync-state'); if (label) label.textContent = syncLabel(); }
        });
        if (!token.dirty) render();
      }
    }
    catch (error) { container.innerHTML = `<h2>作业成绩</h2><p role="alert">${escape(error.message)}</p>`; }
    return token;
  }
  function hasUnsavedChanges() { return Boolean(activeMount && activeMount.dirty); }
  function confirmLeave() {
    if (!hasUnsavedChanges()) return true;
    if (typeof window === 'undefined' || !window.confirm('还有未保存的成绩输入。放弃这些输入并离开？')) return false;
    activeMount.dirty = false; return true;
  }
  return Object.freeze({ mount, createStorage, checkedBook, hasUnsavedChanges, confirmLeave, async prepareImport(options){if(options&&options.bridge&&typeof window!=='undefined'&&window.GradeSyncClient)await window.GradeSyncClient.prepareImport(options.bridge);if(activeMount&&activeMount.prepareImport)await activeMount.prepareImport();},async reloadAfterImport(){if(activeMount&&activeMount.reloadAfterImport)await activeMount.reloadAfterImport();} });
}));
