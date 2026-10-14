const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acorn', {
  getState: () => ipcRenderer.invoke('acorn:get-state'),
  refresh: () => ipcRenderer.invoke('acorn:refresh'),
  login: () => ipcRenderer.invoke('acorn:login'),
  togglePin: () => ipcRenderer.invoke('widget:toggle-pin'),
  hide: () => ipcRenderer.send('widget:hide'),
  openMenu: () => ipcRenderer.send('widget:menu'),
  onUpdate: (cb) => ipcRenderer.on('acorn:update', (_event, payload) => cb(payload)),
  onPinned: (cb) => ipcRenderer.on('widget:pinned', (_event, pinned) => cb(pinned)),
});
