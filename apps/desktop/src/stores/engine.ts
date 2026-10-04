// Trạng thái phản chiếu từ engine (profiles, jobs, hệ thống, real-time) + kết nối sidecar.
import { create } from 'zustand';

import { engine } from '../api/engine';
import type { Job, Profile, RealtimeStats, SystemInfo } from '../api/types';
import { platform, type EngineInfo } from '../lib/platform';

interface EngineState {
  ready: boolean;
  info: EngineInfo;
  voices: Profile[];
  jobs: Record<string, Job>;
  system: SystemInfo | null;
  rt: RealtimeStats;
  init: () => Promise<void>;
}

let started = false;

export const useEngine = create<EngineState>((set, get) => ({
  ready: false,
  info: { status: 'starting', restarts: 0 },
  voices: [],
  jobs: {},
  system: null,
  rt: { running: false, inDb: -120, outDb: -120, latencyMs: 0, underrun: false, underruns: 0 },
  init: async () => {
    if (started) return;
    started = true;
    const e = engine();
    e.subscribe((ev) => {
      if (ev.type === 'voices') set({ voices: ev.voices });
      else if (ev.type === 'job') set({ jobs: { ...get().jobs, [ev.job.id]: ev.job } });
      else if (ev.type === 'realtime') set({ rt: ev.stats });
      else if (ev.type === 'system') set({ system: ev.system });
    });
    platform.onEngineStatus((info) => set({ info }));
    const [info, voices, system] = await Promise.all([platform.engineInfo(), e.listVoices(), e.system()]);
    set({ info: e.mode === 'mock' ? { ...info, status: info.status === 'offline' ? 'offline' : 'mock' } : info, voices, system, ready: true });
  },
}));

/** Job GPU nặng đang chạy (train / TTS / STS). */
export const runningJob = (jobs: Record<string, Job>) =>
  Object.values(jobs).find((j) => j.kind !== 'download' && j.status === 'running');

export const voiceTraining = (v: Profile, jobs: Record<string, Job>) => (v.trainJobId ? jobs[v.trainJobId] : undefined);
export const canSts = (v: Profile) => v.capabilities.includes('sts') && !v.trainJobId;
export const canTts = (v: Profile) => v.capabilities.includes('tts');
