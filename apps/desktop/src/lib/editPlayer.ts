// Phát timeline nhiều track của Edit Audio bằng WebAudio: mỗi clip là một AudioBufferSourceNode + GainNode
// (gain clip × gain track, fade tuyến tính) — cùng quy tắc trộn với engine khi xuất file (services/edit/dsp.py).
// Cũng giữ cache audio đã giải mã + đường bao (peaks) của từng asset để vẽ waveform ở mọi mức zoom.

import type { EditTimeline } from '../api/types';

export const PEAK_RATE = 200; // số bucket mỗi giây (5 ms) — đủ chi tiết khi zoom sát

export interface AssetPeaks {
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
  peak: number;
  durationSec: number;
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

export function audibleTrackIds(t: EditTimeline): Set<string> {
  const solo = t.tracks.some((x) => x.solo && !x.mute);
  return new Set(t.tracks.filter((x) => !x.mute && (!solo || x.solo)).map((x) => x.id));
}

function computePeaks(buf: AudioBuffer): AssetPeaks {
  const data = buf.getChannelData(0);
  const per = Math.max(1, Math.round(buf.sampleRate / PEAK_RATE));
  const n = Math.ceil(data.length / per);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const rms = new Float32Array(n);
  let peak = 0;
  for (let b = 0; b < n; b++) {
    let lo = 0, hi = 0, sq = 0;
    const end = Math.min(data.length, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sq += v * v;
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = Math.sqrt(sq / Math.max(1, end - b * per));
    peak = Math.max(peak, -lo, hi);
  }
  return { min, max, rms, peak, durationSec: buf.duration };
}

class EditAudio {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private peaks = new Map<string, AssetPeaks>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private nodes: AudioBufferSourceNode[] = [];
  private t0 = 0;
  private from = 0;
  private endAt = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  playing = false;

  context() {
    this.ctx ??= new AudioContext({ sampleRate: 48000 });
    return this.ctx;
  }

  has(assetId: string) {
    return this.buffers.has(assetId);
  }

  buffer(assetId: string) {
    return this.buffers.get(assetId);
  }

  peaksOf(assetId: string) {
    return this.peaks.get(assetId);
  }

  /** Giải mã asset một lần (cache theo id — asset không bao giờ bị sửa). */
  load(assetId: string, url: string): Promise<AudioBuffer | null> {
    const hit = this.loading.get(assetId);
    if (hit) return hit;
    const p = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = await this.context().decodeAudioData(await res.arrayBuffer());
        this.buffers.set(assetId, buf);
        this.peaks.set(assetId, computePeaks(buf));
        return buf;
      } catch {
        return null;
      }
    })();
    this.loading.set(assetId, p);
    void p.then((b) => { if (!b) this.loading.delete(assetId); });
    return p;
  }

  /** Mức RMS (tuyến tính) của một đoạn asset — để khớp âm lượng khi thay bằng file / thu âm. */
  rms(assetId: string, offset: number, duration: number): number {
    const buf = this.buffers.get(assetId);
    if (!buf) return 0;
    const d = buf.getChannelData(0);
    const a = Math.max(0, Math.floor(offset * buf.sampleRate));
    const b = Math.min(d.length, Math.floor((offset + duration) * buf.sampleRate));
    let sq = 0;
    for (let i = a; i < b; i++) sq += d[i] * d[i];
    return b > a ? Math.sqrt(sq / (b - a)) : 0;
  }

  position() {
    if (!this.playing || !this.ctx) return this.from;
    return Math.min(this.endAt, this.from + (this.ctx.currentTime - this.t0));
  }

  /** Phát từ `from` đến `to` (mặc định hết timeline). onEnd gọi khi phát hết. */
  play(t: EditTimeline, from: number, onEnd: () => void, to?: number) {
    this.stop();
    const ctx = this.context();
    void ctx.resume();
    const audible = audibleTrackIds(t);
    const tracks = new Map(t.tracks.map((x) => [x.id, x]));
    const stopAt = to ?? t.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    if (stopAt <= from + 1e-3) return;
    this.t0 = ctx.currentTime + 0.05;
    this.from = from;
    this.endAt = stopAt;
    for (const c of t.clips) {
      const buf = this.buffers.get(c.assetId);
      const end = Math.min(c.start + c.duration, stopAt);
      if (!buf || !audible.has(c.trackId) || end <= from || c.start >= stopAt) continue;
      const l0 = Math.max(0, from - c.start); // vị trí bắt đầu phát bên trong clip
      const when = this.t0 + Math.max(0, c.start - from);
      const dur = end - c.start - l0;
      if (dur <= 0) continue;
      const base = dbToGain(c.gainDb + (tracks.get(c.trackId)?.gainDb ?? 0));
      const g = ctx.createGain();
      const env = (l: number) => {
        let v = base;
        if (c.fadeIn > 0 && l < c.fadeIn) v *= l / c.fadeIn;
        if (c.fadeOut > 0 && l > c.duration - c.fadeOut) v *= Math.max(0, (c.duration - l) / c.fadeOut);
        return v;
      };
      g.gain.setValueAtTime(env(l0), when);
      if (c.fadeIn > 0 && l0 < c.fadeIn) g.gain.linearRampToValueAtTime(env(c.fadeIn), when + (c.fadeIn - l0));
      const foStart = c.duration - c.fadeOut;
      if (c.fadeOut > 0) {
        if (l0 < foStart) g.gain.setValueAtTime(env(foStart), when + (foStart - l0));
        g.gain.linearRampToValueAtTime(0, when + (c.duration - l0));
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(g).connect(ctx.destination);
      src.start(when, c.offset + l0, dur);
      this.nodes.push(src);
    }
    this.playing = true;
    this.endTimer = setTimeout(() => {
      this.stop();
      this.from = stopAt;
      onEnd();
    }, (stopAt - from) * 1000 + 80);
  }

  /** Dừng, trả vị trí đang phát. */
  stop(): number {
    const pos = this.position();
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* chưa start */
      }
      n.disconnect();
    }
    this.nodes = [];
    this.playing = false;
    this.from = pos;
    return pos;
  }
}

export const editAudio = new EditAudio();
