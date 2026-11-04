import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('meetingCopilotMenu', {
  openSettings: () => ipcRenderer.invoke('menu:open-settings'),
  quit: () => ipcRenderer.invoke('menu:quit'),
  close: () => ipcRenderer.invoke('menu:close'),
});

window.addEventListener('DOMContentLoaded', () => {
  const settings = document.getElementById('settings');
  const quit = document.getElementById('quit');
  settings?.addEventListener('click', () => {
    void ipcRenderer.invoke('menu:open-settings');
  });
  quit?.addEventListener('click', () => {
    void ipcRenderer.invoke('menu:quit');
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      void ipcRenderer.invoke('menu:close');
    }
  });
});
