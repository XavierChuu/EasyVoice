// Trình phát dùng chung: mỗi lúc một nguồn.
// - url: phát thật bằng <audio> (file người dùng chọn/thu, hoặc audio engine trả về).
// - speak: đọc bằng giọng hệ thống (Web Speech) — CHỈ dùng khi engine là mock, để test luồng TTS trước khi có F5-TTS.
// - không có cả hai: chạy thanh tiến trình giả.
import { create } from 'zustand';

import type { PlaySource } from '../api/types';

interface PlayerState {
  key: string | null;
  position: number; // 0..1
  error: string | null;
  play: (key: string, src: PlaySource) => void;
  stop: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let audio: HTMLAudioElement | null = null;
let token = 0;

export const speechAvailable = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase())
    ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
}

export const usePlayer = create<PlayerState>((set, get) => ({
  key: null,
  position: 0,
  error: null,
  play: (key, src) => {
    get().stop();
    const my = ++token;
    set({ key, position: 0, error: null });
    if (src.url) {
      audio = new Audio(src.url);
      audio.ontimeupdate = () => audio && set({ position: audio.currentTime / (audio.duration || src.durationSec || 1) });
      audio.onended = () => my === token && get().stop();
      audio.onerror = () => my === token && set({ key: null, error: 'decode' });
      void audio.play().catch(() => my === token && set({ key: null, error: 'output' }));
      return;
    }
    if (src.speak && speechAvailable()) {
      const { texts, lang, rate } = src.speak;
      const synth = window.speechSynthesis;
      synth.cancel();
      const voice = pickVoice(lang);
      texts.forEach((text, i) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        u.rate = rate;
        if (voice) u.voice = voice;
        u.onstart = () => my === token && set({ position: i / texts.length });
        u.onend = () => {
          if (my !== token) return;
          if (i === texts.length - 1) get().stop();
          else set({ position: (i + 1) / texts.length });
        };
        u.onerror = () => my === token && get().stop();
        synth.speak(u);
      });
      return;
    }
    const started = performance.now();
    timer = setInterval(() => {
      const p = (performance.now() - started) / 1000 / Math.max(0.5, src.durationSec);
      if (p >= 1) get().stop();
      else set({ position: p });
    }, 50);
  },
  stop: () => {
    token++;
    if (timer) clearInterval(timer);
    timer = null;
    audio?.pause();
    audio = null;
    if (speechAvailable()) window.speechSynthesis.cancel();
    set({ key: null, position: 0 });
  },
}));
