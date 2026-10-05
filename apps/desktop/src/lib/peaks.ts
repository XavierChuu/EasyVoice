// Giải mã audio và rút gọn thành đường bao (min / max / RMS) để vẽ waveform trên canvas.
// Kết quả được cache theo nguồn (URL hoặc Blob) để đổi tab / re-render không phải giải mã lại.

export interface Peaks {
  min: Float32Array; // đáy sóng mỗi bucket, -1..1
  max: Float32Array; // đỉnh sóng mỗi bucket, -1..1
  rms: Float32Array; // năng lượng hiệu dụng mỗi bucket, 0..1
  peak: number; // biên độ tuyệt đối lớn nhất (để chuẩn hóa khi vẽ)
  durationSec: number;
  sampleRate: number;
  channels: number;
}

export type WaveSource = string | Blob;

const BUCKETS = 8192;
const MAX_BYTES = 120e6; // file lớn hơn thì không giải mã trong renderer (video dài...)
const CACHE_LIMIT = 24;

const cache = new Map<string, Promise<Peaks | null>>();
const blobIds = new WeakMap<Blob, number>();
let blobSeq = 0;
let decoder: AudioContext | null = null;

const keyOf = (src: WaveSource) => {
  if (typeof src === 'string') return src;
  if (!blobIds.has(src)) blobIds.set(src, ++blobSeq);
  return `blob:${blobIds.get(src)}`;
};

export function computePeaks(buf: AudioBuffer, buckets = BUCKETS): Peaks {
  const n = buf.length;
  const count = Math.max(1, Math.min(buckets, n));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const rms = new Float32Array(count);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  let peak = 0;
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / count));
    let lo = 0, hi = 0, sq = 0;
    for (let i = from; i < to; i++) {
      let v = 0;
      for (let c = 0; c < chans.length; c++) v += chans[c][i];
      v /= chans.length; // downmix mono
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sq += v * v;
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = Math.sqrt(sq / (to - from));
    peak = Math.max(peak, -lo, hi);
  }
  return { min, max, rms, peak, durationSec: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels };
}

async function load(src: WaveSource): Promise<Peaks | null> {
  try {
    let data: ArrayBuffer;
    if (typeof src === 'string') {
      const res = await fetch(src);
      if (!res.ok) return null;
      data = await res.arrayBuffer();
    } else {
      if (src.size > MAX_BYTES) return null;
      data = await src.arrayBuffer();
    }
    if (data.byteLength > MAX_BYTES) return null;
    decoder ??= new AudioContext();
    return computePeaks(await decoder.decodeAudioData(data));
  } catch {
    return null; // định dạng trình duyệt không giải mã được (vd. video) — waveform trống, không ảnh hưởng chức năng
  }
}

export function loadPeaks(src: WaveSource): Promise<Peaks | null> {
  const key = keyOf(src);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = load(src);
  cache.set(key, p);
  void p.then((r) => { if (!r) cache.delete(key); });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return p;
}

/** Gộp các bucket rơi vào cột pixel [x0, x1) (tính theo tỉ lệ 0..1 của cả đoạn). */
export function columnStats(p: Peaks, f0: number, f1: number) {
  const n = p.min.length;
  const a = Math.min(n - 1, Math.max(0, Math.floor(f0 * n)));
  const b = Math.min(n, Math.max(a + 1, Math.ceil(f1 * n)));
  let lo = 0, hi = 0, sq = 0;
  for (let i = a; i < b; i++) {
    if (p.min[i] < lo) lo = p.min[i];
    if (p.max[i] > hi) hi = p.max[i];
    sq += p.rms[i] * p.rms[i];
  }
  return { lo, hi, rms: Math.sqrt(sq / (b - a)) };
}
