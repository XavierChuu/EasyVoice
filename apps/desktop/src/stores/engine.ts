// Trạng thái phản chiếu từ engine (profiles, jobs, hệ thống, real-time) + kết nối sidecar.
import { create } from 'zustand';

import { connectEngine } from '../api/engine';
import { HttpEngine } from '../api/httpEngine';
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
    const info0 = await platform.engineInfo();
    const e = connectEngine(info0);
    e.subscribe((ev) => {
      if (ev.type === 'voices') set({ voices: ev.voices });
      else if (ev.type === 'job') set({ jobs: { ...get().jobs, [ev.job.id]: ev.job } });
      else if (ev.type === 'realtime') set({ rt: ev.stats });
      else if (ev.type === 'system') set({ system: ev.system });
    });
    platform.onEngineStatus((info) => {
      connectEngine(info); // sidecar khởi động lại với port/token mới
      // Engine chết giữa chừng thì job của nó mất theo: đừng để UI kẹt ở "đang chạy" (job train được engine khôi phục
      // và gửi lại qua WebSocket khi kết nối lại).
      if (info.status === 'restarting') set({ jobs: dropLiveJobs(get().jobs) });
      set({ info });
      if (info.status === 'online') void refresh();
    });
    const refresh = async () => {
      try {
        const [voices, system] = await Promise.all([e.listVoices(), e.system()]);
        set({ voices, system, ready: true });
        if (e instanceof HttpEngine && get().info.status !== 'online') set({ info: { ...get().info, status: 'online' } });
      } catch {
        if (e instanceof HttpEngine) {
          set({ info: { ...get().info, status: get().info.status === 'starting' ? 'starting' : 'offline' }, ready: true });
          setTimeout(() => void refresh(), 1500); // engine chưa lên: thử lại
        }
      }
    };
    set({ info: e.mode === 'mock' && info0.status !== 'setup' ? { ...info0, status: info0.status === 'offline' ? 'offline' : 'mock' } : info0 });
    if (info0.status === 'setup') return; // chờ cài runtime xong (RuntimeSetupModal tải lại cửa sổ)
    await refresh();
  },
}));

function dropLiveJobs(jobs: Record<string, Job>): Record<string, Job> {
  const out: Record<string, Job> = {};
  for (const [id, j] of Object.entries(jobs)) {
    out[id] = j.status === 'running' || j.status === 'queued' ? { ...j, status: 'failed', error: 'ENGINE_RESTARTED' } : j;
  }
  return out;
}

/** Job GPU nặng đang chạy (train / TTS / STS). */
export const runningJob = (jobs: Record<string, Job>) =>
  Object.values(jobs).find((j) => j.kind !== 'download' && j.status === 'running');

export const voiceTraining = (v: Profile, jobs: Record<string, Job>) => (v.trainJobId ? jobs[v.trainJobId] : undefined);
export const canSts = (v: Profile) => v.capabilities.includes('sts') && !v.trainJobId;
export const canTts = (v: Profile) => v.capabilities.includes('tts');
