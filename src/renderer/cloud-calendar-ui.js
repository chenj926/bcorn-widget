/* Foreground-only, explicit cloud-calendar connection. Local saving is independent. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CloudCalendarUI = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PROVIDERS = Object.freeze({ google: 'Google Calendar', microsoft: 'Microsoft Outlook' });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ERROR_COPY = Object.freeze({
    'not-configured': '此构建还未配置登录服务，请使用已配置的构建。',
    'authorization-required': '请重新登录并确认日历权限。',
    'authorization-revoked': '日历授权已失效，请重新连接。',
    'authorization-denied': '此次授权未完成；可以稍后重新连接。',
    'authorization-failed': '登录未完成，请重试并核对所选账户。',
    'calendar-permission-denied': '当前账户不能写入这个日历，请重新选择可写日历。',
    'calendar-target-required': '请先选择目标日历。',
    'target-required': '请先选择目标日历。',
    'calendar-target-confirmation-required': '请核对账户和目标日历，再勾选确认。',
    'account-changed': '账户已变化，请重新确认目标日历。',
    'calendar-changed': '目标日历已变化，请重新打开设置确认。',
    'calendar-conflict': '云端安排已被修改，暂未覆盖。请先核对云端内容。',
    'calendar-ownership-conflict': '无法确认这个云端安排由 bcorn 创建，已停止修改。',
    'calendar-write-uncertain-retry-readback': '服务没有确认保存结果。下次更新会先核对云端，避免重复创建。',
    'calendar-creation-uncertain-check-provider-before-retrying': '服务没有确认新日历是否创建成功，请先在日历服务中检查，避免重复创建。',
    'calendar-created-storage-failed-check-provider-before-retrying': '日历已创建，但本机未能保存连接信息。请先检查云端日历，再重试连接。',
    'calendar-series-limit': '安排超过单次同步上限，请缩小日期范围后重试。',
    'calendar-storage-limit': '本机日历连接记录已达到容量上限，暂时无法继续写入。',
    'calendar-storage-error': '本机连接记录暂时无法读取或保存；课表仍保留。',
    'calendar-storage-busy': '本机正在保存日历连接，请稍后重试。',
    'calendar-busy': '正在处理另一个日历操作，请稍后重试。',
    'rate-limited': '日历服务暂时限制请求，请稍后重试。',
    'offline': '当前无法联网，回到前台联网后会再尝试。',
    'network-error': '连接日历服务失败，请检查网络后重试。',
    'background-paused': '窗口已进入后台，日历更新已暂停。',
    'background-or-cancelled': '此次操作已暂停或取消。',
    'cancelled': '已取消此次操作。'
  });
  const errorCopy = err => {
    const code = String(err?.message || err);
    return ERROR_COPY[code] || (/^[a-z]+(?:-[a-z]+)+$/.test(code) ? `日历操作未完成，请重试。错误代码：${code}` : code);
  };
  function create({ invoke, document: doc, openDialog, getData, notify = () => {}, buildSeries, storage, prepareData = async data => data }) {
    let provider = '', statuses = {}, targets = [], error = '', busy = false, disposed = false, authorizing = false;
    let queue = Promise.resolve(), pending = null, deletion = null, confirmedDeletion = null, revision = 0, dialogEpoch = 0;
    const foreground = () => !disposed && !doc.hidden;
    const preferenceKey = 'bcorn-cloud-calendar-reminders-v1';
    const reminders = { google: 10, microsoft: 10 };
    const importPauseKey = 'bcorn-cloud-calendar-import-pause-v1';
    const importPaused = new Set();
    try {
      storage = storage || doc.defaultView?.localStorage;
      const paused = JSON.parse(storage?.getItem(importPauseKey) || '[]');
      if (Array.isArray(paused)) for (const p of paused) if (Object.hasOwn(PROVIDERS, p)) importPaused.add(p);
      const saved = JSON.parse(storage?.getItem(preferenceKey) || '{}');
      for (const p of Object.keys(PROVIDERS)) if ([null, 5, 10, 15, 30].includes(saved[p])) reminders[p] = saved[p];
    } catch (_) { /* An unavailable local preference store never blocks local timetable use. */ }

    const call = async (action, args = {}) => {
      const result = await invoke(action, args);
      if (result?.ok === false || result?.error) throw new Error(result.message || result.error || '云日历操作未完成。');
      return result;
    };
    const report = err => { error = errorCopy(err); notify(`课表保存在本地；云日历更新未完成：${error}`); };
    async function readStatus(p) { statuses[p] = await call('status', { provider: p }); return statuses[p]; }
    async function loadTargets() {
      const result = await call('targets', { provider });
      targets = Array.isArray(result) ? result : (result?.targets || []);
    }
    function ownsDialog() {
      const panel = doc.querySelector('#cloud-calendar-panel, #cloud-calendar-delete');
      return !!panel && panel.closest('dialog')?.open !== false;
    }
    function render(force = false) {
      if (!force && !ownsDialog()) return;
      const status = statuses[provider], missing = status && (status.configured === false || /missing.config|unconfigured|not.configured/i.test(status.state || ''));
      const storageUnavailable = status?.state === 'storage-unavailable';
      const connected = !missing && !storageUnavailable && !!status?.accountLabel && !/authorization.required|revoked|disconnected/.test(status.state || '');
      openDialog('连接云日历', `<section id="cloud-calendar-panel" class="cloud-calendar-panel" aria-busy="${busy}">
        <p>选择服务、登录账户，再确认写入的日历。仅在窗口前台保存课表、启动或返回前台时同步已启用的连接；退出或隐藏后不会定时同步。</p>
        <label class="field"><span>日历服务</span><select id="cloud-calendar-provider" ${busy ? 'disabled' : ''}><option value="">请选择服务</option>${Object.entries(PROVIDERS).map(([id, label]) => `<option value="${id}" ${id === provider ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        ${provider ? `<p class="field-hint">${provider === 'google' ? 'Google 日历权限为 calendar.app.created：仅访问此应用创建的专用日历，不读取现有个人日历。' : 'Microsoft 请求 Calendars.ReadWrite：可读取和修改账户日历。应用仅向你确认的可写日历写入课程，并只删除它自己记录的安排。登录时请核对所选账户。'}</p>
        ${storageUnavailable ? '<p role="alert">此设备的受保护日历凭据存储不可用，暂时无法连接或同步。请检查系统凭据存储后重试；本地课表不受影响。</p>' : ''}
        ${missing ? '<p role="status">此构建尚未配置该服务的 OAuth 客户端，暂时无法连接。请使用已配置的构建。本地课表仍可使用。</p>' : ''}
        ${connected ? `<p>账户：<strong>${escape(status.accountLabel)}</strong></p><p>状态：${importPaused.has(provider) ? '导入后已暂停，请重新确认目标后启用' : status.enabled ? '已启用前台自动更新' : '尚未启用自动更新'}${status.target ? ` · ${escape(status.target.name)}` : ''}</p>
        <label class="field"><span>目标日历</span><select id="cloud-calendar-target"><option value="">请选择目标日历</option>${targets.map(t => `<option value="${escape(t.id)}">${escape(t.name)}</option>`).join('')}</select></label>
        <label class="field"><span>提前提醒（保存在此设备）</span><select id="cloud-calendar-reminder">${[[null, '不提醒'], [5, '5 分钟'], [10, '10 分钟'], [15, '15 分钟'], [30, '30 分钟']].map(([value, label]) => `<option value="${value === null ? 'none' : value}" ${reminders[provider] === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <p class="field-hint">每次同步最多 1,000 个具体课程安排。Google 使用一个弹出提醒，Microsoft 使用一个提醒；服务或设备的通知设置可能阻止提醒送达。提醒设置会在下次更新时应用。</p>
        ${provider === 'google' ? '<button class="secondary-btn" data-cloud-calendar="create">创建 bcorn 专用日历</button>' : ''}
        <label class="cloud-calendar-consent"><input type="checkbox" id="cloud-calendar-consent"> 我确认此账户和目标日历，并允许保存课表后自动新增或更新课程；删除前另行确认。</label>
        <button class="primary-btn" data-cloud-calendar="bind">确认目标并启用更新</button>
        ${status.enabled ? '<button class="secondary-btn" data-cloud-calendar="sync">立即更新</button>' : ''}
        <button class="text-btn" data-cloud-calendar="disconnect">断开连接并停止更新</button><p class="field-hint">断开连接保留已写入的云端安排；不会删除本地课表。重新连接需再次确认目标。</p>` : `<button class="primary-btn" data-cloud-calendar="connect" ${missing || storageUnavailable ? 'disabled' : ''}>选择账户并授权 ${escape(PROVIDERS[provider])}</button>`}` : ''}
        ${authorizing ? '<p role="status">请在浏览器中选择账户并授权。</p><button class="secondary-btn" data-cloud-calendar="cancel">取消此次授权</button>' : ''}
        <p id="cloud-calendar-error" class="form-error" role="alert">${escape(error)}</p></section>`, null, { push: false });
    }
    async function openSettings() {
      const epoch = ++dialogEpoch;
      error = ''; render(true);
      if (provider) {
        try { await readStatus(provider); if (statuses[provider]?.accountLabel && !/authorization.required|revoked|disconnected|storage.unavailable|not.configured|missing.config|unconfigured/.test(statuses[provider].state || '') && statuses[provider].configured !== false) await loadTargets(); }
        catch (err) { error = errorCopy(err); }
      }
      if (epoch === dialogEpoch) render();
    }
    async function syncOne(p, data, startedRevision = revision) {
      if (!foreground() || startedRevision !== revision || importPaused.has(p)) return;
      const status = await readStatus(p);
      if (!status?.enabled || !status.target || !foreground() || startedRevision !== revision) return;
      const prepared = await prepareData(data);
      if (!foreground() || startedRevision !== revision || importPaused.has(p)) return;
      const series = buildSeries(prepared, reminders[p]);
      const result = await call('sync', { provider: p, series, allowDelete: false });
      if (startedRevision === revision && deletion?.provider === p) { deletion = null; confirmedDeletion = null; }
      if (startedRevision === revision && Number(result?.pendingDeleteCount || result?.pendingDeletes || 0) > 0) {
        deletion = { provider: p, series, revision: startedRevision, targetId: status.target.id, accountLabel: status.accountLabel, targetName: status.target.name, count: Number(result.pendingDeleteCount || result.pendingDeletes) };
        notify('课程已更新。有已移除的课程仍保留在云端，请在云日历设置中确认删除。');
      }
      return result;
    }
    function onTimetableSaved(data) {
      if (!data) return Promise.resolve();
      revision++; deletion = null; confirmedDeletion = null;
      if (!foreground()) return Promise.resolve();
      pending = { data, revision };
      queue = queue.then(async () => {
        while (pending && foreground()) {
          const next = pending; pending = null;
          for (const p of Object.keys(PROVIDERS)) {
            if (!foreground()) break;
            try { await syncOne(p, next.data, next.revision); } catch (err) { report(err); }
          }
        }
        pending = null;
      }).catch(report);
      return queue;
    }
    function confirmDeletion() {
      if (!deletion) return;
      confirmedDeletion = deletion;
      openDialog('删除已移除课程的云端安排？', `<section id="cloud-calendar-delete"><p>将从 ${escape(PROVIDERS[deletion.provider])}（账户 ${escape(deletion.accountLabel)}，日历 ${escape(deletion.targetName)}）删除 ${deletion.count} 个由 bcorn 写入、现已不在课表中的安排。其他云端内容和本地课表会保留。</p><button class="secondary-btn" data-action="close-dialog">保留云端安排</button><button class="danger-btn" data-cloud-calendar="delete">确认删除这些安排</button><p id="cloud-calendar-error" role="alert"></p></section>`, null, { push: true });
    }
    async function handleAction(event) {
      const button = event.target.closest('[data-cloud-calendar]');
      if (!button || disposed) return;
      const action = button.dataset.cloudCalendar;
      if (action === 'cancel' && authorizing) {
        button.disabled = true;
        try { await call('cancel', { provider }); } catch (err) { report(err); }
        return;
      }
      if (busy) return;
      if (action === 'review-delete') { confirmDeletion(); return; }
      const actionEpoch = dialogEpoch;
      busy = true; button.disabled = true; error = '';
      try {
        if (!foreground()) throw new Error('请在前台窗口中操作云日历。');
        if (action === 'connect') {
          authorizing = true; render();
          try { await call('connect', { provider }); await readStatus(provider); await loadTargets(); }
          finally { authorizing = false; }
        }
        if (action === 'create') { await call('create_target', { provider, name: 'bcorn timetable' }); await loadTargets(); }
        if (action === 'bind') {
          const calendarId = doc.querySelector('#cloud-calendar-target')?.value;
          if (!calendarId || !doc.querySelector('#cloud-calendar-consent')?.checked) throw new Error('请选择目标日历，并勾选账户和目标确认。');
          await queue;
          revision++; deletion = null; confirmedDeletion = null;
          await call('bind', { provider, calendarId, confirmed: true });
          importPaused.delete(provider);
          storage?.setItem(importPauseKey, JSON.stringify([...importPaused]));
          await readStatus(provider);
          if (getData()) await syncOne(provider, getData());
        }
        if (action === 'sync') { await queue; if (getData()) await syncOne(provider, getData()); }
        if (action === 'disconnect') {
          pending = null; revision++; confirmedDeletion = null; await queue; await call('disconnect', { provider });
          if (deletion?.provider === provider) deletion = null;
          await readStatus(provider); targets = [];
        }
        if (action === 'delete') {
          if (!deletion || deletion !== confirmedDeletion || deletion.revision !== revision) throw new Error('课表已改变，请重新更新并确认删除。');
          await queue;
          if (deletion !== confirmedDeletion || deletion?.revision !== revision) throw new Error('课表已改变，请重新更新并确认删除。');
          const request = deletion;
          const current = await readStatus(request.provider);
          if (request !== deletion || request.revision !== revision || !foreground()) throw new Error('课表已改变，请重新更新并确认删除。');
          if (!current.enabled || current.target?.id !== request.targetId || current.accountLabel !== request.accountLabel) throw new Error('云日历账户或目标已改变，请重新确认。');
          deletion = null; confirmedDeletion = null;
          // Later saves wait for this already-confirmed operation, then reconcile their latest snapshot.
          const deleting = call('sync', { provider: request.provider, series: request.series, allowDelete: true });
          queue = deleting.catch(() => {});
          try { await deleting; }
          catch (err) { if (request.revision === revision) deletion = request; throw err; }
          notify('已删除确认的云端安排，本地课表保留。');
        }
      } catch (err) { error = errorCopy(err); }
      finally { busy = false; button.disabled = false; if (actionEpoch === dialogEpoch) { render(); appendDeletionButton(); } }
    }
    function appendDeletionButton() {
      const panel = doc.querySelector('#cloud-calendar-panel');
      if (!deletion || !panel) return;
      const button = doc.createElement('button'); button.className = 'text-btn';
      button.dataset.cloudCalendar = 'review-delete'; button.textContent = `查看并确认删除 ${deletion.count} 个云端安排…`;
      panel.appendChild(button);
    }
    async function changeProvider(event) {
      if (event.target.id === 'cloud-calendar-reminder' && provider && !busy) {
        const value = event.target.value === 'none' ? null : Number(event.target.value);
        if (![null, 5, 10, 15, 30].includes(value)) return;
        const previous = reminders[provider]; reminders[provider] = value;
        try {
          if (!storage) throw new Error('此设备无法保存提醒偏好。');
          storage.setItem(preferenceKey, JSON.stringify(reminders));
          revision++; deletion = null; confirmedDeletion = null;
        } catch (err) { reminders[provider] = previous; error = errorCopy(err); render(); }
        return;
      }
      if (event.target.id !== 'cloud-calendar-provider' || busy) return;
      provider = Object.hasOwn(PROVIDERS, event.target.value) ? event.target.value : '';
      busy = true; targets = [];
      try { await openSettings(); } finally { busy = false; render(); appendDeletionButton(); }
    }
    async function visibilityChanged() {
      const visible = foreground();
      if (!visible) pending = null;
      try {
        await call('set_foreground', { foreground: visible });
        // One event-driven reconciliation recovers offline/interrupted saves. No timer or polling.
        if (visible && foreground() && !authorizing && getData()) await onTimetableSaved(getData());
      } catch (err) { report(err); }
    }
    doc.addEventListener('click', handleAction); doc.addEventListener('change', changeProvider);
    doc.addEventListener('visibilitychange', visibilityChanged);
    const ready = visibilityChanged();
    return Object.freeze({
      async pauseForImport() {
        for (const p of Object.keys(PROVIDERS)) importPaused.add(p);
        storage?.setItem(importPauseKey, JSON.stringify([...importPaused]));
        revision++; pending = null; deletion = null; confirmedDeletion = null;
        await queue;
      },
      openSettings: async () => { await openSettings(); appendDeletionButton(); }, onTimetableSaved, ready,
      dispose() { disposed = true; pending = null; doc.removeEventListener('click', handleAction); doc.removeEventListener('change', changeProvider); doc.removeEventListener('visibilitychange', visibilityChanged); void call('set_foreground', { foreground: false }).catch(() => {}); }
    });
  }
  return Object.freeze({ create });
}));
