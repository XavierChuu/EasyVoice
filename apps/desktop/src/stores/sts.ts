import { create } from 'zustand';

import type { FileRef } from '../api/types';

export type RtPreset = 'low' | 'balanced' | 'quality';

export const RT_PRESETS: Record<RtPreset, { blockMs: number; contextSec: number; crossfadeMs: number }> = {
  low: { blockMs: 100, contextSec: 1.0, crossfadeMs: 40 },
  balanced: { blockMs: 160, contextSec: 1.5, crossfadeMs: 60 },
  quality: { blockMs: 250, contextSec: 2.0, crossfadeMs: 80 },
};

interface StsState {
  mode: 'offline' | 'rt';
  profileId: string;
  pitch: number;
  // offline
  file: FileRef | null;
  fileDurationSec: number;
  separate: boolean;
  indexRate: number;
  protect: number;
  jobId: string | null;
  // real-time
  inputId: string;
  outputId: string;
  preset: RtPreset;
  blockMs: number;
  contextSec: number;
  crossfadeMs: number;
  gateDb: number;
  /** Ghi giọng đã đổi ra file ngay khi bật live. */
  recordLive: boolean;
  set: (patch: Partial<Omit<StsState, 'set'>>) => void;
}

export const useSts = create<StsState>((set) => ({
  mode: 'offline',
  profileId: 'p1',
  pitch: 0,
  file: null,
  fileDurationSec: 0,
  separate: true,
  indexRate: 0.5,
  protect: 0.33,
  jobId: null,
  inputId: '',
  outputId: '',
  preset: 'balanced',
  ...RT_PRESETS.balanced,
  gateDb: -45,
  recordLive: false,
  set: (patch) => set(patch),
}));
