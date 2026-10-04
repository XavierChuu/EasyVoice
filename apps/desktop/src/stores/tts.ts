import { create } from 'zustand';

interface TtsState {
  text: string;
  profileId: string;
  mode: 'direct' | 'chain';
  speed: number;
  seed: number;
  jobId: string | null;
  set: (patch: Partial<Omit<TtsState, 'set'>>) => void;
}

export const useTts = create<TtsState>((set) => ({
  text: '',
  profileId: 'p1',
  mode: 'direct',
  speed: 1,
  seed: 1234,
  jobId: null,
  set: (patch) => set(patch),
}));
