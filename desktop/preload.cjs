const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent0', {
  state: () => ipcRenderer.invoke('agent:state'),
  personalState: () => ipcRenderer.invoke('agent:personal-state'),
  personalSetFocus: (focus) => ipcRenderer.invoke('agent:personal-set-focus', focus),
  personalAddGoal: (title) => ipcRenderer.invoke('agent:personal-add-goal', title),
  personalRemoveGoal: (id) => ipcRenderer.invoke('agent:personal-remove-goal', id),
  personalAddTask: (title, goalId) => ipcRenderer.invoke('agent:personal-add-task', { title, goalId }),
  personalUpdateTask: (input) => ipcRenderer.invoke('agent:personal-update-task', input),
  personalAddNote: (content) => ipcRenderer.invoke('agent:personal-add-note', content),
  personalJournal: (content) => ipcRenderer.invoke('agent:personal-journal', content),
  backgroundState: () => ipcRenderer.invoke('agent:background-state'),
  cancelSchedule: (scheduleId) => ipcRenderer.invoke('agent:background-cancel-schedule', scheduleId),
  jobOutput: (jobId) => ipcRenderer.invoke('agent:background-job-output', jobId),
  createSession: (title) => ipcRenderer.invoke('agent:session-create', title),
  switchSession: (id) => ipcRenderer.invoke('agent:session-switch', id),
  renameSession: (id, title) => ipcRenderer.invoke('agent:session-rename', { id, title }),
  deleteSession: (id) => ipcRenderer.invoke('agent:session-delete', id),
  skillsList: () => ipcRenderer.invoke('agent:skills-list'),
  send: (prompt) => ipcRenderer.invoke('agent:send', prompt),
  abort: () => ipcRenderer.invoke('agent:abort'),
  resolveApproval: (id, approved) => ipcRenderer.invoke('agent:approval-resolve', { id, approved }),
  reset: () => ipcRenderer.invoke('agent:reset'),
  remember: (content) => ipcRenderer.invoke('agent:remember', content),
  memoryList: (scope) => ipcRenderer.invoke('agent:memory-list', scope),
  memorySearch: (query, scope) => ipcRenderer.invoke('agent:memory-search', { query, scope }),
  memoryAdd: (content, scope) => ipcRenderer.invoke('agent:memory-add', { content, scope }),
  memoryUpdate: (id, content, scope) => ipcRenderer.invoke('agent:memory-update', { id, content, scope }),
  memoryForget: (id) => ipcRenderer.invoke('agent:memory-forget', id),
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
