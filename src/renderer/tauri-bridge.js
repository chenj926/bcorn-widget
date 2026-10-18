/* Same renderer, narrow Tauri 2 native bridge. Inert in Electron and browsers. */
(() => {
  'use strict';
  if (window.acorn || !window.__TAURI__?.core?.invoke) return;
  const { invoke } = window.__TAURI__.core;
  const updates = new Set();
  const pins = new Set();
  const reportError = (error) => {
    const payload = { status: { state: 'error', message: String(error?.message || error) } };
    updates.forEach((callback) => callback(payload));
  };
  // Register native listeners before getState so menu actions cannot race setup.
  const ready = Promise.all([
    window.__TAURI__.event.listen('acorn:update', ({ payload }) => updates.forEach((cb) => cb(payload))),
    window.__TAURI__.event.listen('widget:pinned', ({ payload }) => pins.forEach((cb) => cb(payload))),
  ]);
  ready.catch(reportError);
  const action = (command, args) => invoke(command, args).catch((error) => {
    reportError(error);
    return { error: String(error?.message || error) };
  });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    invoke('set_grade_sync_foreground', { foreground: !document.hidden }).catch(() => {});
  });
  window.acorn = Object.freeze({
    platform: 'tauri',
    capabilities: Object.freeze({ login: false, refresh: false, import: true, exportCalendar: true, localCache: true, pin: true }),
    getState: async () => { await ready; return invoke('get_state'); },
    refresh: () => action('refresh'),
    login: () => action('login'),
    togglePin: () => action('toggle_pin'),
    // Minimize retains a taskbar entry so a hidden widget cannot get stranded.
    hide: () => action('minimize'),
    openMenu: () => action('open_menu'),
    cloudCalendar: (action, args = {}) => invoke('cloud_calendar_call', { request: { ...args, action } }),
    getGradeSyncStatus: () => invoke('get_grade_sync_status'),
    connectGradeSheet: ({ title, tab }) => invoke('connect_grade_sheet', { title, tab }),
    createMappedGradeSheet: ({ course }) => invoke('create_mapped_grade_sheet', { course }),
    pickGradeSheet: () => invoke('pick_grade_sheet'),
    previewGradeSheet: ({ selectionId, sheetId }) => invoke('preview_grade_sheet', { selectionId, sheetId }),
    confirmGradeSheetMapping: ({ selectionId, mapping }) => invoke('confirm_grade_sheet_mapping', { selectionId, mapping }),
    readMappedGradeSnapshot: ({ connectionId }) => invoke('read_mapped_grade_snapshot', { connectionId }),
    commitMappedGradeCells: ({ connectionId, expectedSnapshot, writes }) => invoke('commit_mapped_grade_cells', { connectionId, expectedSnapshot, writes }),
    gradeSheetsRequest: (request) => invoke('grade_sheets_request', { request }),
    gradeSheetVersion: () => invoke('grade_sheet_version'),
    disconnectGradeSheet: ({ revokeGoogle = false } = {}) => invoke('disconnect_grade_sheet', { revokeGoogle }),
    cancelGradeAuthorization: () => invoke('cancel_grade_authorization'),
    loadGradeSyncState: (connectionId) => invoke('load_grade_sync_state', { connectionId }),
    saveGradeSyncState: (connectionId, envelope) => invoke('save_grade_sync_state', { connectionId, envelope }),
    loadGradeBook: () => invoke('load_grade_book'),
    saveGradeBook: (book) => invoke('save_grade_book', { book }),
    saveData: (data) => invoke('save_data', { data }),
    clearData: () => invoke('clear_data'),
    exportCalendar: ({ filename, content }) => invoke('export_calendar', { filename, content }),
    openExternal: (url) => invoke('open_external', { url }),
    onUpdate(callback) { updates.add(callback); return () => updates.delete(callback); },
    onPinned(callback) { pins.add(callback); return () => pins.delete(callback); },
  });
})();
