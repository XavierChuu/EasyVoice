import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { Sidecar, type EngineInfo } from './sidecar';

let win: BrowserWindow | null = null;
let sidecar: Sidecar | null = null;
let engineInfo: EngineInfo = { status: 'mock', restarts: 0 };

function broadcast(info: EngineInfo) {
  engineInfo = info;
  win?.webContents.send('engine:status', info);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0A0A0A',
    title: 'EasyVoice',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '../dist/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('dialog:pickFiles', async (_e, opts: { title?: string; multiple?: boolean; filters?: Electron.FileFilter[] }) => {
  if (!win) return [];
  const r = await dialog.showOpenDialog(win, {
    title: opts.title,
    filters: opts.filters,
    properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p), size: statSync(p).size }));
});
ipcMain.handle('dialog:pickFolder', async (_e, title?: string) => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:showInFolder', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('shell:openExternal', (_e, url: string) => {
  if (/^https:\/\//.test(url)) return shell.openExternal(url);
});
ipcMain.handle('fs:readText', (_e, p: string) => {
  // Chỉ đọc file .txt người dùng vừa chọn (mở văn bản cho TTS), giới hạn 5 MB.
  if (!/\.txt$/i.test(p) || statSync(p).size > 5e6) throw new Error('unsupported file');
  return readFileSync(p, 'utf8');
});
ipcMain.handle('engine:info', () => engineInfo);
ipcMain.handle('engine:restart', () => sidecar?.restart());
ipcMain.handle('app:paths', () => ({ downloads: app.getPath('downloads'), userData: app.getPath('userData') }));

void app.whenReady().then(async () => {
  createWindow();
  const loc = Sidecar.locate(app.getAppPath());
  if (loc) {
    sidecar = new Sidecar(loc.engineDir, loc.python, broadcast);
    await sidecar.start().catch((err: Error) => broadcast({ ...engineInfo, status: 'offline', lastError: err.message }));
  } else {
    broadcast({ status: 'mock', restarts: 0 });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => sidecar?.stop());
app.on('window-all-closed', () => {
  sidecar?.stop();
  if (process.platform !== 'darwin') app.quit();
});
