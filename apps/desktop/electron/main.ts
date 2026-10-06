import { app, BrowserWindow, dialog, ipcMain, net, session, shell, systemPreferences } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { setupHotkeys } from './hotkeys';
import {
  dataDir, detectTorch, ensureRuntime, estimateGb, runtimeDirs, runtimeReady, type RuntimeProgress, type TorchFlavor,
} from './runtime';
import { Sidecar, type EngineInfo } from './sidecar';

let win: BrowserWindow | null = null;
let sidecar: Sidecar | null = null;
let engineInfo: EngineInfo = { status: 'mock', restarts: 0 };
// Chỉ đọc lại được những file người dùng vừa chọn qua hộp thoại (không cho renderer đọc file tùy ý).
const picked = new Set<string>();
const MAX_READ = 100e6;
const stopHotkeys = setupHotkeys(() => win?.webContents);

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
    title: 'Evoice',
    // Bản cài đặt dùng icon của file .exe/.app; khi chạy dev thì lấy build/icon.png.
    ...(app.isPackaged ? {} : { icon: path.join(app.getAppPath(), 'build', 'icon.png') }),
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

// Micro: renderer chỉ cần audio (thu đoạn ref 5-12 s). Chỉ cấp cho trang của app, từ chối camera/quyền khác.
function setupPermissions() {
  const isAppPage = (url: string) => url.startsWith('file://') || url.startsWith(process.env.VITE_DEV_SERVER_URL ?? '\0');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const media = permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio');
    callback(!!media && isAppPage(wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && isAppPage(wc.getURL()));
}

ipcMain.handle('mic:access', async () => {
  // macOS: hệ điều hành phải cho phép riêng (System Settings → Privacy & Security → Microphone).
  if (process.platform === 'darwin') {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return 'granted';
    return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  }
  if (process.platform === 'win32') return systemPreferences.getMediaAccessStatus('microphone');
  return 'granted';
});

ipcMain.handle('dialog:pickFiles', async (_e, opts: { title?: string; multiple?: boolean; filters?: Electron.FileFilter[] }) => {
  if (!win) return [];
  const r = await dialog.showOpenDialog(win, {
    title: opts.title,
    filters: opts.filters,
    properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (r.canceled) return [];
  r.filePaths.forEach((p) => picked.add(p));
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
ipcMain.handle('fs:readPicked', (_e, p: string) => {
  if (!picked.has(p) || statSync(p).size > MAX_READ) throw new Error('not allowed');
  return readFileSync(p);
});
ipcMain.handle('fs:readText', (_e, p: string) => {
  // Chỉ đọc file .txt người dùng vừa chọn (mở văn bản cho TTS), giới hạn 5 MB.
  if (!/\.txt$/i.test(p) || statSync(p).size > 5e6) throw new Error('unsupported file');
  return readFileSync(p, 'utf8');
});
ipcMain.handle('engine:info', () => engineInfo);

// ---------- runtime Python của bản cài đặt (Phase 6) ----------
let installing: Promise<void> | null = null;
let torchFlavor: TorchFlavor | null = null;
ipcMain.handle('runtime:info', () => {
  const dirs = runtimeDirs(dataDir(app.getPath('appData')));
  torchFlavor ??= detectTorch();
  return { torch: torchFlavor, sizeGb: estimateGb(torchFlavor), dir: dirs.root, installing: !!installing };
});
ipcMain.handle('runtime:install', () => {
  installing ??= (async () => {
    const engineDir = packagedEngineDir();
    const dirs = runtimeDirs(dataDir(app.getPath('appData')));
    torchFlavor ??= detectTorch();
    try {
      const python = await ensureRuntime(engineDir, dirs, torchFlavor, (p: RuntimeProgress) => win?.webContents.send('runtime:progress', p),
        { fetcher: (url) => net.fetch(url) });
      await startSidecar(engineDir, python);
    } finally {
      installing = null;
    }
  })();
  return installing;
});
ipcMain.handle('engine:restart', () => sidecar?.restart());
ipcMain.handle('app:paths', () => ({ downloads: app.getPath('downloads'), userData: app.getPath('userData') }));

/** Bản cài đặt: mã engine nằm trong resources/engine (electron-builder extraResources). */
function packagedEngineDir(): string {
  return process.env.EASYVOICE_ENGINE_DIR ?? path.join(process.resourcesPath, 'engine');
}

/** FFmpeg bản LGPL đóng kèm app (scripts/fetch-ffmpeg.mjs); không có thì engine dùng FFmpeg trong PATH. */
function bundledFfmpeg(): NodeJS.ProcessEnv {
  const exe = path.join(process.resourcesPath ?? '', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return app.isPackaged && existsSync(exe) ? { EASYVOICE_FFMPEG: exe } : {};
}

async function startSidecar(engineDir: string, python: string) {
  sidecar?.stop();
  sidecar = new Sidecar(engineDir, python, broadcast, bundledFfmpeg());
  await sidecar.start().catch((err: Error) => broadcast({ ...engineInfo, status: 'offline', lastError: err.message }));
}

function setupAutoUpdate() {
  // Chỉ bản cài đặt: kiểm tra bản mới của app shell (gói nhỏ) và cài khi thoát app (spec mục 8).
  if (!app.isPackaged || process.env.EASYVOICE_NO_UPDATE === '1') return;
  import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      return autoUpdater.checkForUpdatesAndNotify();
    })
    .catch(() => { /* không có mạng / chưa cấu hình kênh phát hành: bỏ qua */ });
}

void app.whenReady().then(async () => {
  setupPermissions();
  createWindow();
  setupAutoUpdate();
  // 1) Chạy từ source (dev): engine/.venv cạnh repo. 2) Bản cài đặt: runtime trong thư mục dữ liệu, chưa có thì cài.
  const loc = !app.isPackaged && process.env.EASYVOICE_FORCE_SETUP !== '1' ? Sidecar.locate(app.getAppPath()) : null;
  if (loc) {
    await startSidecar(loc.engineDir, loc.python);
  } else if ((app.isPackaged || process.env.EASYVOICE_FORCE_SETUP === '1') && process.env.EASYVOICE_MOCK !== '1') {
    const engineDir = packagedEngineDir();
    const dirs = runtimeDirs(dataDir(app.getPath('appData')));
    torchFlavor = detectTorch();
    if (runtimeReady(dirs, engineDir, torchFlavor)) await startSidecar(engineDir, dirs.python);
    else broadcast({ status: 'setup', restarts: 0 });
  } else {
    broadcast({ status: 'mock', restarts: 0 });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopHotkeys();
  sidecar?.stop();
});
app.on('window-all-closed', () => {
  sidecar?.stop();
  if (process.platform !== 'darwin') app.quit();
});
