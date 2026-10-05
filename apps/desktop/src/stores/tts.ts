import { create } from 'zustand';

import type { Segment } from '../lib/segments';

interface TtsState {
  text: string;
  profileId: string;
  /** Biến thể của giọng chính; null = giọng chuẩn. */
  variantId: string | null;
  /** Đoạn gán giọng riêng (bôi đen → chuột phải). */
  segments: Segment[];
  mode: 'direct' | 'chain';
  speed: number;
  seed: number;
  jobId: string | null;
  set: (patch: Partial<Omit<TtsState, 'set'>>) => void;
}

export const useTts = create<TtsState>((set) => ({
  text: '',
  profileId: 'p1',
  variantId: null,
  segments: [],
  mode: 'direct',
  speed: 1,
  seed: 1234,
  jobId: null,
  set: (patch) => set(patch),
}));
