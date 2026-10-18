/* Native-only authorization and transport binding. No OAuth tokens cross this interface. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./google-sheets'), require('./grade-sync'), require('./foreground-sync'), require('./sheet-mapping'));
  else root.GradeSyncClient = factory(root.BcornSheets, root.GradeSync, root.GradeForegroundSync, root.SheetMapping);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Sheets, GradeSync, Foreground, Mapping) {
  'use strict';
  const sessions = new WeakMap();
  const importBlocked = new WeakMap();
  const pendingMappings = new WeakMap();
  const PENDING_MAPPING_KEY = 'bcorn.gradeSync.pendingMapping.v1';
  function pendingMapping(bridge){try{return pendingMappings.get(bridge)===true||(typeof localStorage!=='undefined'&&localStorage.getItem(PENDING_MAPPING_KEY)==='true');}catch(_){return true;}}
  function setPendingMapping(bridge,value){if(typeof localStorage!=='undefined'){if(value)localStorage.setItem(PENDING_MAPPING_KEY,'true');else localStorage.removeItem(PENDING_MAPPING_KEY);}pendingMappings.set(bridge,value);}
  const clone = value => JSON.parse(JSON.stringify(value));
  const nativeMessage=code=>({'authorization-required':'请重新授权 Google。','revoked':'Google 授权已撤销，请重新连接。','not-configured':'此版本尚未配置 Google 连接。','offline':'当前离线，修改仍保留在本机。','network-error':'网络连接暂不可用，请稍后重试。','rate-limited':'Google 请求暂时受限，请稍后重试。','relink-required':'连接或工作表已变化，请重新确认同步目标。','cancelled':'已取消选择。','busy':'已有连接操作进行中，请稍候。','conflict':'表格出现不同版本，请先处理冲突。','mapping-stale':'原表位置或名称变化，请重新映射。','mapping-required':'当前变更需要重新映射工作表。','formula-protected':'不能写入公式、合并或受保护的单元格。','verification-failed':'写入后未能核对一致结果，修改仍保留，请检查冲突。','preview-limit':'请将映射限制在 A1:Z200 范围。','invalid-mapping':'映射无效，请检查单元格位置。'}[code]||'原生操作未完成，请重试或检查连接设置。');
  const normalizeNativeCode=code=>({'sheet-conflict':'conflict','formula-or-protected-cell':'formula-protected','mapping-anchor-changed':'mapping-stale','mapping-changed':'mapping-stale','write-verification-failed':'verification-failed','selection-expired':'relink-required','sheet-preview-limit':'preview-limit','invalid-sheet-mapping':'invalid-mapping','background-paused':'offline','connection-changed':'authorization-required'}[code]||code);
  async function nativeCall(bridge, method, ...args) {
    let result;
    try { result = await bridge[method](...args); }
    catch (failure) {
      const raw = normalizeNativeCode(typeof failure === 'string' ? failure : failure && (failure.code || failure.message));
      const codes = ['authorization-required','revoked','not-configured','offline','network-error','rate-limited','relink-required','background-paused','connection-changed','cancelled','busy','conflict','mapping-stale','mapping-required','formula-protected','verification-failed','preview-limit','invalid-mapping'];
      const error = new Error(nativeMessage(raw));
      error.code = codes.includes(raw) ? (raw === 'background-paused' ? 'offline' : raw === 'connection-changed' ? 'authorization-required' : raw) : 'native-error';
      if (failure && Number.isFinite(failure.retryAfterMs)) error.retryAfterMs = failure.retryAfterMs;
      throw error;
    }
    if (result && result.ok === false) {
      const detail = result.error || {};
      const code=normalizeNativeCode(detail.code);
      const error = new Error(nativeMessage(code));
      error.code = typeof code === 'string' ? code : 'native-error';
      if (Number.isFinite(detail.retryAfterMs)) error.retryAfterMs = detail.retryAfterMs;
      throw error;
    }
    return result;
  }
  async function getSession(bridge, bookStore) {
    if (!bridge || typeof bridge !== 'object') return null;
    if (sessions.has(bridge)) return sessions.get(bridge);
    const required = ['getGradeSyncStatus', 'gradeSheetsRequest', 'loadGradeSyncState', 'saveGradeSyncState'];
    const supported = required.every(name => typeof bridge[name] === 'function');
    const listeners = new Set();
    const localWrites = new Set();
    const cleanups = [];
    let mapped = null, fullBook = null, scopedBookStore = null, transitionGeneration = 0, transitioning = false;
    let status = { status: 'not-configured', automaticInbound: false }, service = null, connectionId = null, unsubscribeService = null, foreground = null, paused = false;
    const emit = next => { const prior = { ...status }; delete prior.book; status = { ...prior, ...next, paused, foregroundAuto: Boolean(!paused && foreground && foreground.snapshot().enabled) }; for (const fn of listeners) { try { fn(clone(status)); } catch (_) {} } };
    async function refresh() {
      if (!supported || transitioning) return status;
      const generation=transitionGeneration;
      const native = await nativeCall(bridge, 'getGradeSyncStatus');
      if(generation!==transitionGeneration||transitioning)return status;
      if (!native || typeof native.state !== 'string') throw new Error('Invalid native sync status.');
      emit({ status: native.state, automaticInbound: native.automaticInbound === true, message: native.message || '' });
      if (native.state !== 'ready' || !native.binding || !native.connectionId || !native.deviceId) {
        if (service) { service.dispose(); service = null; connectionId = null; } if (foreground) { foreground.dispose(); foreground = null; }
        return status;
      }
      let blocked=pendingMapping(bridge)||importBlocked.get(bridge)===native.connectionId;
      try { blocked=blocked||(typeof localStorage!=='undefined'&&localStorage.getItem('bcorn.gradeSync.importBlocked.'+native.connectionId)==='true'); } catch (_) { blocked=true; }
      if(blocked){if(service)service.dispose();if(foreground)foreground.dispose();service=null;connectionId=null;emit({status:'relink-required',message:'连接尚未通过完整核对，请重新预览并确认同步目标。'});return status;}
      if (connectionId === native.connectionId && service) return status;
      if (service) service.dispose(); if (foreground) foreground.dispose(); if (unsubscribeService) unsubscribeService();
      connectionId = native.connectionId;
      const currentId = connectionId;
      try { paused = typeof localStorage !== 'undefined' && localStorage.getItem('bcorn.gradeSync.paused.' + currentId) === 'true'; } catch (_) { paused = true; }
      mapped = native.binding.kind === 'mapped' ? Mapping.normalizeMapping(native.binding.mapping) : null;
      const mappedIds = new Set(mapped ? mapped.courses.map(c => c.id) : []);
      const subset = book => ({schemaVersion:1,courses:book.courses.filter(c => mappedIds.has(c.id))});
      fullBook = await bookStore.load();
      if(generation!==transitionGeneration||transitioning||pendingMapping(bridge))return status;
      scopedBookStore = mapped ? {
        async load() { fullBook = await bookStore.load(); return subset(fullBook); },
        async save(part) { const latest = await bookStore.load(); fullBook = {...latest,courses:[...latest.courses.filter(c => !mappedIds.has(c.id)),...part.courses]}; await bookStore.save(fullBook); }
      } : bookStore;
      const adapter = mapped ? Mapping.createAdapter({mapping:mapped,
        getVersion: typeof bridge.gradeSheetVersion==='function' ? async()=>{const latest=await nativeCall(bridge,'getGradeSyncStatus');if(latest.connectionId!==currentId){const error=new Error('Connection changed.');error.code='authorization-required';throw error;}return nativeCall(bridge,'gradeSheetVersion');} : undefined,
        authorizationStatus: async () => { const latest = await nativeCall(bridge,'getGradeSyncStatus'); return latest.connectionId === currentId ? latest.state : 'authorization-required'; },
        readSnapshot: () => nativeCall(bridge,'readMappedGradeSnapshot',{connectionId:currentId}),
        commitMappedCells: typeof bridge.commitMappedGradeCells === 'function' ? op => nativeCall(bridge,'commitMappedGradeCells',{connectionId:currentId,expectedSnapshot:op.expectedSnapshot,writes:op.writes}) : undefined
      }) : Sheets.createAdapter({ binding: native.binding, inboundPushConfigured: async () => { const latest = await nativeCall(bridge, 'getGradeSyncStatus'); return latest.connectionId === currentId && latest.automaticInbound === true; },
        getVersion: typeof bridge.gradeSheetVersion === 'function' ? async () => {
          const latest = await nativeCall(bridge, 'getGradeSyncStatus');
          if (latest.connectionId !== currentId) { const error = new Error('Connection changed.'); error.code = 'authorization-required'; throw error; }
          return nativeCall(bridge, 'gradeSheetVersion');
        } : undefined,
        async authorizationStatus() {
          const latest = await nativeCall(bridge, 'getGradeSyncStatus');
          return latest.connectionId === currentId ? latest.state : 'authorization-required';
        },
        async request(request) {
          const latest = await nativeCall(bridge, 'getGradeSyncStatus');
          if (latest.connectionId !== currentId) { const error = new Error('Connection changed; old outbox remains isolated.'); error.code = 'authorization-required'; throw error; }
          return nativeCall(bridge, 'gradeSheetsRequest', request);
        }
      });
      service = GradeSync.createService({ bookStore: scopedBookStore, adapter, deviceId: native.deviceId, syncStore: {
        load: () => nativeCall(bridge, 'loadGradeSyncState', currentId),
        async save(envelope) { const result = await nativeCall(bridge, 'saveGradeSyncState', currentId, envelope); if (!result || result.ok !== true) throw new Error('Synchronization journal was not saved.'); }
      } });
      const activeService = service;
      foreground = Foreground.createScheduler({ reconcile: () => activeService.notifyRemoteChange(), visible: typeof document === 'undefined' || !document.hidden, online: typeof navigator === 'undefined' || navigator.onLine !== false });
      unsubscribeService = service.subscribe(state => {
        if(service!==activeService||transitioning)return;
        if (state.status === 'pending' && !paused) foreground.activity();
        if (['revoked', 'authorization-required', 'not-configured'].includes(state.status)) foreground.stop();
        emit(state.book && mapped ? {...state,book:fullBook} : state);
      });
      service.setActive(!paused && (typeof document === 'undefined' || !document.hidden) && (typeof navigator === 'undefined' || navigator.onLine !== false));
      await activeService.start();
      if(generation!==transitionGeneration||transitioning||service!==activeService)return status;
      if (!paused && !['revoked', 'authorization-required', 'not-configured'].includes(status.status)) foreground.start(false); emit({});
      return status;
    }
    const session = Object.freeze({
      get service() { if(transitioning||!service)return null;const target=service;if(!mapped)return {...target,saveBook(next){const operation=target.saveBook(next);localWrites.add(operation);operation.finally(()=>localWrites.delete(operation)).catch(()=>{});return operation;}};return {
        saveBook(next) { const operation=(async()=>{
          const ids = new Set(mapped.courses.map(c => c.id));
          const part = {schemaVersion:1,courses:next.courses.filter(c => ids.has(c.id))};
          // Structure/labels/status remain fixed until the user explicitly remaps.
          for (const c of mapped.courses) {
            const candidate=part.courses.find(x=>x.id===c.id);
            if (!candidate || candidate.title!==c.title || candidate.termId!==c.termId || candidate.rules.kind!==c.rules.kind || candidate.assessments.length!==c.assessments.length || c.assessments.some(a=>{const found=candidate.assessments.find(x=>x.id===a.id);return !found||found.title!==a.title||found.status==='exempt';})) throw new Error('已映射课程只能修改成绩和权重；结构、规则或豁免需要重新映射。');
          }
          await bookStore.save(next); fullBook=clone(next); await target.saveBook(part); return clone(fullBook);
        })();localWrites.add(operation);operation.finally(()=>localWrites.delete(operation)).catch(()=>{});return operation;
        },
        resolve: (...args) => target.resolve(...args), idle: () => target.idle()
      }; },
      get status() { return clone(status); },
      get canConnect() { return typeof bridge.connectGradeSheet === 'function' && !transitioning && !pendingMapping(bridge); },
      canCreateMapped: typeof bridge.createMappedGradeSheet === 'function',
      async createMapped(course) {
        Mapping.template(course);
        await this.prepareMapping();
        const latestCourse=(await bookStore.load()).courses.find(c=>c.id===course.id);
        if(JSON.stringify(latestCourse)!==JSON.stringify(course))throw new Error('本机课程已变化，请检查最新成绩后重新确认创建。');
        setPendingMapping(bridge,true);
        const result=await nativeCall(bridge,'createMappedGradeSheet',{course});
        if(!result||(result.ok!==true&&result.state!=='ready')) throw new Error('新成绩表尚未创建成功。');
        const native=await nativeCall(bridge,'getGradeSyncStatus');
        if(native.state!=='ready'||native.binding?.kind!=='mapped'||!native.connectionId)throw new Error('新成绩表绑定尚未通过核对。');
        const created=Mapping.bookFromSnapshot(native.binding.mapping,await nativeCall(bridge,'readMappedGradeSnapshot',{connectionId:native.connectionId}));
        if(JSON.stringify(created.courses)!==JSON.stringify([course]))throw new Error('新成绩表内容未能核对一致，自动同步保持暂停。');
        setPendingMapping(bridge,false);
        transitioning=false;
        return refresh();
      },
      async blockForImport() {
        await this.prepareMapping();
        const native=await nativeCall(bridge,'getGradeSyncStatus');
        if(native.connectionId){importBlocked.set(bridge,native.connectionId);if(typeof localStorage!=='undefined')localStorage.setItem('bcorn.gradeSync.importBlocked.'+native.connectionId,'true');}
        if(service)service.setActive(false);if(foreground)foreground.stop();
        if(service){await service.idle();service.dispose();}service=null;connectionId=null;emit({status:'relink-required',message:'导入备份后，请重新确认同步目标。'});
      },
      canMap: typeof bridge.pickGradeSheet === 'function' && typeof bridge.previewGradeSheet === 'function' && typeof bridge.confirmGradeSheetMapping === 'function',
      get mappedCourseIds() { return mapped ? mapped.courses.map(c=>c.id) : []; },
      async prepareMapping() {
        transitioning=true;transitionGeneration++;paused=true;emit({status:'relink-required',message:'正在确认新的同步目标。'});
        const previous=service;
        if(previous)previous.setActive(false);if(foreground)foreground.stop();
        if(connectionId&&typeof localStorage!=='undefined')localStorage.setItem('bcorn.gradeSync.paused.'+connectionId,'true');
        await Promise.allSettled([...localWrites]);
        if(previous)await previous.idle();
        if(previous)previous.dispose();if(unsubscribeService)unsubscribeService();if(foreground)foreground.dispose();
        service=null;foreground=null;unsubscribeService=null;connectionId=null;
      },
      async confirmMapping({selectionId,mapping,book}) {
        await this.prepareMapping();
        setPendingMapping(bridge,true);
        const result=await nativeCall(bridge,'confirmGradeSheetMapping',{selectionId,mapping});
        const native=result && result.connectionId ? result : await nativeCall(bridge,'getGradeSyncStatus');
        if(native.state!=='ready'||!native.connectionId) throw new Error('映射连接尚未完成。');
        const fresh=Mapping.bookFromSnapshot(mapping,await nativeCall(bridge,'readMappedGradeSnapshot',{connectionId:native.connectionId}));
        if(JSON.stringify(fresh)!==JSON.stringify(book)) throw new Error('预览后成绩表已变化，请重新预览并确认；未覆盖本机成绩。');
        const latest=await bookStore.load(), ids=new Set(book.courses.map(c=>c.id));
        const merged={...latest,courses:[...latest.courses.filter(c=>!ids.has(c.id)),...book.courses]};
        await bookStore.save(merged);
        if(JSON.stringify(await bookStore.load())!==JSON.stringify(merged))throw new Error('本机导入未能核对成功；同步保持暂停，请重新确认。');
        setPendingMapping(bridge,false);
        transitioning=false;
        return refresh();
      },
      subscribe(fn) { listeners.add(fn); fn(clone(status)); return () => listeners.delete(fn); },
      async connect() {
        if(transitioning||pendingMapping(bridge))throw new Error('连接尚未完成。请重新选择并确认映射，或为课程新建易读成绩表。');
        if (typeof bridge.connectGradeSheet !== 'function') throw new Error('此版本尚未配置原生 Google 授权。');
        emit({ status: 'connecting' });
        try {
          const result = await nativeCall(bridge, 'connectGradeSheet', { title: 'bcorn grades', tab: 'Assessments' });
          if (!result || (result.ok !== true && result.state !== 'ready')) { await refresh(); throw new Error('连接未完成；本机成绩仍保留。'); }
          return await refresh();
        } catch (error) { emit({ status: 'not-configured' }); throw error; }
      },
      async setPaused(value) {
        if (!connectionId || !service) return;
        const next = Boolean(value);
        if (typeof localStorage !== 'undefined') localStorage.setItem('bcorn.gradeSync.paused.' + connectionId, String(next));
        paused = next;
        const active = !paused && (typeof document === 'undefined' || !document.hidden) && (typeof navigator === 'undefined' || navigator.onLine !== false);
        service.setActive(active);
        if (paused) foreground.stop(); else foreground.start(true);
        emit({});
      },
      refresh,
      async notifyRemoteChange(hint) { if (hint && hint.connectionId && hint.connectionId !== connectionId) return; if (service && !paused) return service.notifyRemoteChange(); },
      async dispose() { if (service) service.dispose(); if (foreground) foreground.dispose(); if (unsubscribeService) unsubscribeService(); listeners.clear(); for (const cleanup of cleanups) cleanup(); sessions.delete(bridge); }
    });
    sessions.set(bridge, session);
    if (typeof bridge.onGradeRemoteChange === 'function') { const unsubscribe = bridge.onGradeRemoteChange(hint => session.notifyRemoteChange(hint).catch(() => {})); if (typeof unsubscribe === 'function') cleanups.push(unsubscribe); }
    if (typeof window !== 'undefined') {
      const online = () => { if (service) service.setActive(!paused && !document.hidden && navigator.onLine !== false); if (foreground) foreground.setOnline(navigator.onLine !== false); };
      const visible = () => { if (service) service.setActive(!paused && !document.hidden && navigator.onLine !== false); if (foreground) foreground.setVisible(!document.hidden); };
      const activity = () => { if (foreground && !paused) foreground.activity(); };
      window.addEventListener('online', online); window.addEventListener('offline', online); document.addEventListener('visibilitychange', visible); document.addEventListener('pointerdown', activity, { passive: true });
      cleanups.push(() => window.removeEventListener('online', online), () => window.removeEventListener('offline', online), () => document.removeEventListener('visibilitychange', visible), () => document.removeEventListener('pointerdown', activity));
    }
    try { await refresh(); } catch (_) { emit({ status: 'error', error: { code: 'native-setup-error' } }); }
    return session;
  }
  async function prepareImport(bridge) {
    if(!bridge||typeof bridge.getGradeSyncStatus!=='function')return;
    const existing=sessions.get(bridge);if(existing)return existing.blockForImport();
    const native=await nativeCall(bridge,'getGradeSyncStatus');
    if(native.connectionId){importBlocked.set(bridge,native.connectionId);if(typeof localStorage!=='undefined')localStorage.setItem('bcorn.gradeSync.importBlocked.'+native.connectionId,'true');}
  }
  return Object.freeze({ getSession, nativeCall, prepareImport });
}));
