const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('scrawl', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args)),
  // Where a file dropped on a page lives on disk (Tweak's editor opens files dropped on it).
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});
