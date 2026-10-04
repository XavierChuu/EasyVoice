// Bọc API của preload (window.easyvoice). Khi chạy trong trình duyệt (npm run dev) thì dùng fallback
// <input type="file"> để vẫn dựng và test được UI.

import type { FileRef } from '../api/types';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export type EngineStatus = 'starting' | 'online' | 'restarting' | 'offline' | 'mock';

export interface EngineInfo {
  status: EngineStatus;
  port?: number;
  token?: string;
  restarts: number;
  lastError?: string;
}

interface Bridge {
  platform: string;
  pickFiles(opts: { title?: string; multiple?: boolean; filters?: FileFilter[] }): Promise<FileRef[]>;
  pickFolder(title?: string): Promise<string | null>;
  readText(path: string): Promise<string>;
  showInFolder(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  engineInfo(): Promise<EngineInfo>;
  restartEngine(): Promise<void>;
  appPaths(): Promise<{ downloads: string; userData: string }>;
  onEngineStatus(cb: (info: EngineInfo) => void): () => void;
}

declare global {
  interface Window {
    easyvoice?: Bridge;
  }
}

const bridge = (): Bridge | undefined => window.easyvoice;

export const isElectron = () => !!bridge();

export const osName = (): 'windows' | 'mac' | 'other' => {
  const p = bridge()?.platform ?? navigator.platform.toLowerCase();
  if (p.startsWith('win')) return 'windows';
  if (p === 'darwin' || p.startsWith('mac')) return 'mac';
  return 'other';
};

function browserPick(multiple: boolean, filters?: FileFilter[]): Promise<FileRef[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (filters?.length) input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    input.onchange = () =>
      resolve(Array.from(input.files ?? []).map((f) => ({ path: f.name, name: f.name, size: f.size, file: f })));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export const platform = {
  pickFiles: (opts: { title?: string; multiple?: boolean; filters?: FileFilter[] }) =>
    bridge()?.pickFiles(opts) ?? browserPick(!!opts.multiple, opts.filters),
  pickFolder: async (title?: string) => (await bridge()?.pickFolder(title)) ?? null,
  readText: (ref: FileRef): Promise<string> => (ref.file ? ref.file.text() : bridge()!.readText(ref.path)),
  showInFolder: (path: string) => bridge()?.showInFolder(path) ?? Promise.resolve(),
  openExternal: (url: string) => {
    if (bridge()) return bridge()!.openExternal(url);
    window.open(url, '_blank', 'noopener');
    return Promise.resolve();
  },
  engineInfo: async (): Promise<EngineInfo> => (await bridge()?.engineInfo()) ?? { status: 'mock', restarts: 0 },
  restartEngine: () => bridge()?.restartEngine() ?? Promise.resolve(),
  appPaths: async () => (await bridge()?.appPaths()) ?? { downloads: '~/Downloads', userData: '~/.easyvoice' },
  onEngineStatus: (cb: (info: EngineInfo) => void) => bridge()?.onEngineStatus(cb) ?? (() => {}),
};

export const AUDIO_FILTER: FileFilter = { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg'] };
export const MEDIA_FILTER: FileFilter = {
  name: 'Audio / Video',
  extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'mp4', 'mkv', 'mov', 'webm'],
};
