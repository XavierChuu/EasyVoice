// Trình phát dùng chung: mỗi lúc một nguồn. Có URL thì phát thật (vd. file vừa thu âm),
// không có thì giả lập thanh tiến trình (mock engine chưa sinh audio).
import { create } from 'zustand';

interface PlayerState {
  key: string | null;
  position: number; // 0..1
  play: (key: string, durationSec: number, url?: string) => void;
  stop: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let audio: HTMLAudioElement | null = null;

export const usePlayer = create<PlayerState>((set, get) => ({
  key: null,
  position: 0,
  play: (key, durationSec, url) => {
    get().stop();
    set({ key, position: 0 });
    if (url) {
      audio = new Audio(url);
      audio.ontimeupdate = () => audio && set({ position: audio.currentTime / (audio.duration || durationSec) });
      audio.onended = () => get().stop();
      void audio.play().catch(() => get().stop());
      return;
    }
    const started = performance.now();
    timer = setInterval(() => {
      const p = (performance.now() - started) / 1000 / Math.max(0.5, durationSec);
      if (p >= 1) get().stop();
      else set({ position: p });
    }, 50);
  },
  stop: () => {
    if (timer) clearInterval(timer);
    timer = null;
    audio?.pause();
    audio = null;
    set({ key: null, position: 0 });
  },
}));
