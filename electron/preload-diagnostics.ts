import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('meetingCopilot', {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  getSession: () => ipcRenderer.invoke('session:get'),
  onSessionUpdated: (callback: (session: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, session: unknown) => {
      callback(session);
    };
    ipcRenderer.on('session:updated', listener);
    return () => ipcRenderer.removeListener('session:updated', listener);
  },
  quit: () => ipcRenderer.invoke('app:quit'),
  getAiState: () => ipcRenderer.invoke('ai:get-state'),
  setAiProvider: (providerId: string) => ipcRenderer.invoke('ai:set-provider', providerId),
  setAiBaseUrl: (baseUrl: string) => ipcRenderer.invoke('ai:set-base-url', baseUrl),
  setAiApiKey: (apiKey: string) => ipcRenderer.invoke('ai:set-api-key', apiKey),
  clearAiApiKey: () => ipcRenderer.invoke('ai:clear-api-key'),
  listAiModels: () => ipcRenderer.invoke('ai:list-models'),
  setAiModel: (model: string) => ipcRenderer.invoke('ai:set-model', model),
  setAiEffort: (effort: string) => ipcRenderer.invoke('ai:set-effort', effort),
  openLogFolder: () => ipcRenderer.invoke('app:open-log-folder'),
  onLog: (callback: (entry: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: unknown) => {
      callback(entry);
    };
    ipcRenderer.on('diagnostics:log', listener);
    return () => ipcRenderer.removeListener('diagnostics:log', listener);
  },
});
