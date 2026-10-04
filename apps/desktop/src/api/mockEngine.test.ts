import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockEngine } from './mockEngine';
import { EngineError, type Job } from './types';

describe('MockEngine job rules (spec mục 5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const collect = (e: MockEngine) => {
    const jobs: Record<string, Job> = {};
    e.subscribe((ev) => { if (ev.type === 'job') jobs[ev.job.id] = ev.job; });
    return jobs;
  };

  it('runs one heavy GPU job at a time; TTS waits behind training', async () => {
    const e = new MockEngine();
    const jobs = collect(e);
    const id = await e.startTts({ profileId: 'p1', text: 'Một. Hai.', mode: 'direct', speed: 1, seed: 1, pauseMs: 0, dict: [] });
    expect(jobs[id].status).toBe('queued');
    expect(jobs[id].waitingFor).toBe('Cartoon Character');
  });

  it('real-time is rejected while a job holds the GPU, and blocks new jobs while running', async () => {
    const e = new MockEngine();
    const cfg = { profileId: 'p1', inputId: 'a', outputId: 'b', preset: 'balanced' as const, blockMs: 160, contextSec: 1.5, crossfadeMs: 60, pitch: 0, gateDb: -45 };
    await expect(e.startRealtime(cfg)).rejects.toMatchObject({ code: 'GPU_BUSY_JOB' });
    const voices = await e.listVoices();
    await e.cancelJob(voices.find((v) => v.trainJobId)!.trainJobId!); // tạm dừng train
    const start = e.startRealtime(cfg);
    await vi.advanceTimersByTimeAsync(400);
    await start;
    await expect(e.startTts({ profileId: 'p1', text: 'x', mode: 'direct', speed: 1, seed: 1, pauseMs: 0, dict: [] })).rejects.toBeInstanceOf(EngineError);
    await expect(e.resumeJob('nope')).resolves.toBeUndefined();
  });

  it('pausing training keeps progress and resume continues from it', async () => {
    const e = new MockEngine();
    const jobs = collect(e);
    const v = (await e.listVoices()).find((p) => p.trainJobId)!;
    await vi.advanceTimersByTimeAsync(1200);
    await e.cancelJob(v.trainJobId!);
    const paused = jobs[v.trainJobId!];
    expect(paused.status).toBe('paused');
    await e.resumeJob(v.trainJobId!);
    expect(jobs[v.trainJobId!].status).toBe('running');
    expect(jobs[v.trainJobId!].progress).toBeGreaterThanOrEqual(paused.progress);
  });

  it('blocks unsafe .pth imports', async () => {
    const e = new MockEngine();
    const p = e.inspectImport([{ path: 'free_voice_pack.pth', name: 'free_voice_pack.pth', size: 1 }]);
    await vi.advanceTimersByTimeAsync(800);
    const ins = await p;
    expect(ins.blocked).toBe(true);
    await expect(e.importVoice(ins.token, 'x')).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
  });
});
