/* Android bridge for the unmodified shared renderer. Only local assets can reach AcornNative. */
(() => {
  'use strict';
  const callbacks = { update: new Set(), pinned: new Set() };
  const pending = new Map();
  let sequence = 0;
  let interaction = 0;
  // Count actual UI navigation, not pointer-down: edge-back gestures can dispatch cancelled touches.
  for (const event of ['click', 'input', 'change', 'scroll']) {
    window.addEventListener?.(event, () => { interaction += 1; }, true);
  }
  window.__acornNativeBackState = () => ({
    consumed: Boolean(window.acornHandleBack && window.acornHandleBack()), interaction
  });
  const invoke = (method, value) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    try { AcornNative.call(id, method, JSON.stringify(value ?? null)); }
    catch (error) { pending.delete(id); reject(error); }
  });
  window.__acornNativeReply = (id, result, error) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error)); else request.resolve(result);
  };
  window.__acornNativeUpdate = payload => callbacks.update.forEach(cb => cb(payload));
  window.acorn = Object.freeze({
    platform: 'android',
    capabilities: Object.freeze({ login: false, refresh: false, acornAuth: false, pin: false, import: true, export: true }),
    getState: () => invoke('getState'),
    refresh: () => invoke('refresh'),
    login: () => invoke('login'),
    togglePin: () => invoke('togglePin'),
    hide: () => invoke('hide'),
    openMenu: () => invoke('openMenu'),
    saveData: data => invoke('saveData', data),
    clearData: () => invoke('clearData'),
    importData: () => invoke('importData'),
    exportCalendar: payload => invoke('exportCalendar', payload),
    exportFile: payload => invoke('exportCalendar', { filename: payload.filename || payload.name, content: payload.content }),
    openExternal: url => invoke('openExternal', url),
    addCalendarEvent: event => invoke('addCalendarEvent', event),
    onUpdate: callback => { callbacks.update.add(callback); return () => callbacks.update.delete(callback); },
    onPinned: callback => { callbacks.pinned.add(callback); return () => callbacks.pinned.delete(callback); }
  });
})();
