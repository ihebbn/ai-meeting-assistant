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
  toggleListen: () => ipcRenderer.invoke('session:toggle-listen'),
  setListening: (listening: boolean) =>
    ipcRenderer.invoke('session:set-listening', listening),
  hideAll: () => ipcRenderer.invoke('session:hide-all'),
  toggleHidden: () => ipcRenderer.invoke('session:toggle-hidden'),
  toggleMenu: (anchor: unknown) => ipcRenderer.invoke('overlay:toggle-menu', anchor),
  closeMenu: () => ipcRenderer.invoke('overlay:close-menu'),
  toggleTranscript: () => ipcRenderer.invoke('session:toggle-transcript'),
  setPanelOpen: (panel: 'insights' | 'response', open: boolean) =>
    ipcRenderer.invoke('session:set-panel-open', panel, open),
  togglePanel: (panel: 'insights' | 'response') =>
    ipcRenderer.invoke('session:toggle-panel', panel),
  runAction: (actionId: string) => ipcRenderer.invoke('session:run-action', actionId),
  ask: (prompt: string) => ipcRenderer.invoke('session:ask', prompt),
  setFollowUpDraft: (draft: string) =>
    ipcRenderer.invoke('session:set-follow-up-draft', draft),
  closeResponse: () => ipcRenderer.invoke('session:close-response'),
  resizePanel: (width: number, height: number) =>
    ipcRenderer.invoke('overlay:resize-panel', width, height),
  getPanelSize: () => ipcRenderer.invoke('overlay:get-panel-size'),
  copyText: (text: string) => ipcRenderer.invoke('app:copy-text', text),
  quit: () => ipcRenderer.invoke('app:quit'),
  openDiagnostics: () => ipcRenderer.invoke('app:open-diagnostics'),
  openMicSettings: () => ipcRenderer.invoke('app:open-mic-settings'),
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),
  reportAudioActivity: (activity: unknown) =>
    ipcRenderer.invoke('session:report-audio-activity', activity),
  reportListenStatus: (payload: unknown) =>
    ipcRenderer.invoke('session:report-listen-status', payload),
  appendTranscript: (line: unknown) =>
    ipcRenderer.invoke('session:append-transcript', line),
  upsertTranscript: (line: unknown) =>
    ipcRenderer.invoke('session:upsert-transcript', line),
  ensureTranscriber: () => ipcRenderer.invoke('listen:ensure-transcriber'),
  transcribePcm: (payload: unknown) => ipcRenderer.invoke('listen:transcribe-pcm', payload),
});
