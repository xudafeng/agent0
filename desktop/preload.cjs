const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent0', {
  state: () => ipcRenderer.invoke('agent:state'),
  skillsList: () => ipcRenderer.invoke('agent:skills-list'),
  send: (prompt) => ipcRenderer.invoke('agent:send', prompt),
  reset: () => ipcRenderer.invoke('agent:reset'),
  remember: (content) => ipcRenderer.invoke('agent:remember', content),
  configure: (config) => ipcRenderer.invoke('agent:configure', config),
  jevSave: (config) => ipcRenderer.invoke('agent:jev-save', config),
  mcpList: () => ipcRenderer.invoke('agent:mcp-list'),
  mcpPickDirectory: () => ipcRenderer.invoke('agent:mcp-pick-directory'),
  mcpCheck: (id) => ipcRenderer.invoke('agent:mcp-check', id),
  mcpTest: (server) => ipcRenderer.invoke('agent:mcp-test', server),
  mcpSave: (servers) => ipcRenderer.invoke('agent:mcp-save', servers),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
});
