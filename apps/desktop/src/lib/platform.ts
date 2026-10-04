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
  micAccess(): Promise<string>;
  readPicked(path: string): Promise<Uint8Array>;
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

const MIME: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', webm: 'audio/webm',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', txt: 'text/plain',
};
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

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
  pickFiles: async (opts: { title?: string; multiple?: boolean; filters?: FileFilter[] }): Promise<FileRef[]> => {
    const b = bridge();
    if (!b) return browserPick(!!opts.multiple, opts.filters);
    const refs = await b.pickFiles(opts);
    // Đọc kèm nội dung file nhỏ để renderer phân tích/nghe thử được (file lớn chỉ engine đọc).
    for (const ref of refs) {
      if (ref.size > 100e6) continue;
      try {
        const bytes = await b.readPicked(ref.path);
        ref.file = new File([bytes as BlobPart], ref.name, { type: mimeOf(ref.name) });
      } catch {
        /* để engine xử lý */
      }
    }
    return refs;
  },
  pickFolder: async (title?: string) => (await bridge()?.pickFolder(title)) ?? null,
  /** 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' */
  micAccess: async () => (await bridge()?.micAccess()) ?? 'granted',
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
