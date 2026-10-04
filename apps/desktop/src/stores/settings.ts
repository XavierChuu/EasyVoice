// Cài đặt người dùng (renderer). Engine sẽ lưu bản chính thức trong settings.json ở thư mục dữ liệu (spec mục 6);
// ở đây lưu localStorage cho tới khi có engine.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { DictEntry } from '../api/types';

export type UiLang = 'vi' | 'en';

export interface SettingsState {
  lang: UiLang;
  firstRunDone: boolean;
  modelsDir: string;
  voicesDir: string;
  device: 'auto' | 'gpu' | 'cpu';
  ttsFormat: 'wav' | 'mp3' | 'flac';
  pauseMs: number;
  dict: DictEntry[];
  author: string;
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      lang: 'vi',
      firstRunDone: false,
      modelsDir: '',
      voicesDir: '',
      device: 'auto',
      ttsFormat: 'wav',
      pauseMs: 250,
      dict: [],
      author: '',
      set: (patch) => set(patch),
    }),
    { name: 'ev.settings' },
  ),
);
