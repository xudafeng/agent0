const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent0', {
  state: () => ipcRenderer.invoke('agent:state'),
  send: (prompt) => ipcRenderer.invoke('agent:send', prompt),
  reset: () => ipcRenderer.invoke('agent:reset'),
  remember: (content) => ipcRenderer.invoke('agent:remember', content),
  configure: (config) => ipcRenderer.invoke('agent:configure', config),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
});
