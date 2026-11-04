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
  openLogFolder: () => ipcRenderer.invoke('app:open-log-folder'),
  onLog: (callback: (entry: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: unknown) => {
      callback(entry);
    };
    ipcRenderer.on('diagnostics:log', listener);
    return () => ipcRenderer.removeListener('diagnostics:log', listener);
  },
});
