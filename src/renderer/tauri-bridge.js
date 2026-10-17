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
    saveData: (data) => invoke('save_data', { data }),
    clearData: () => invoke('clear_data'),
    exportCalendar: ({ filename, content }) => invoke('export_calendar', { filename, content }),
    openExternal: (url) => invoke('open_external', { url }),
    onUpdate(callback) { updates.add(callback); return () => updates.delete(callback); },
    onPinned(callback) { pins.add(callback); return () => pins.delete(callback); },
  });
})();
