const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acme', {
  connectIMessage: () => ipcRenderer.invoke('connect-imessage'),
});
