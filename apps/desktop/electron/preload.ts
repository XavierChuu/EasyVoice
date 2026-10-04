// Cầu nối tối thiểu cho renderer (contextIsolation). Không lộ Node/ipcRenderer trực tiếp.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('easyvoice', {
  platform: process.platform,
  pickFiles: (opts: unknown) => ipcRenderer.invoke('dialog:pickFiles', opts),
  pickFolder: (title?: string) => ipcRenderer.invoke('dialog:pickFolder', title),
  readText: (p: string) => ipcRenderer.invoke('fs:readText', p),
  showInFolder: (p: string) => ipcRenderer.invoke('shell:showInFolder', p),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  engineInfo: () => ipcRenderer.invoke('engine:info'),
  restartEngine: () => ipcRenderer.invoke('engine:restart'),
  appPaths: () => ipcRenderer.invoke('app:paths'),
  onEngineStatus: (cb: (info: unknown) => void) => {
    const h = (_e: unknown, info: unknown) => cb(info);
    ipcRenderer.on('engine:status', h);
    return () => ipcRenderer.removeListener('engine:status', h);
  },
});
