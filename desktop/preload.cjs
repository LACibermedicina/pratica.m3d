const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rv', { salvarServidor: (url) => ipcRenderer.invoke('salvar-servidor', url) });
