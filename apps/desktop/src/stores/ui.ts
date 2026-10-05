import { create } from 'zustand';

import { usePlayer } from './player';

export type Tab = 'voices' | 'tts' | 'sts' | 'settings' | 'licenses';

export interface Toast {
  id: number;
  text: string;
  path?: string; // nút "Mở thư mục"
}

interface UiState {
  tab: Tab;
  notice: string;
  toasts: Toast[];
  setTab: (tab: Tab) => void;
  setNotice: (notice: string) => void;
  toast: (text: string, path?: string) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  tab: 'voices',
  notice: '',
  toasts: [],
  setTab: (tab) => {
    // Rời trang thì dừng audio đang nghe thử (giọng mẫu, câu TTS, A/B…), không để phát tiếp ở nền.
    if (tab !== get().tab) usePlayer.getState().stop();
    set({ tab, notice: '' });
  },
  setNotice: (notice) => set({ notice }),
  toast: (text, path) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text, path }].slice(-4) });
    setTimeout(() => get().dismissToast(id), 6000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
