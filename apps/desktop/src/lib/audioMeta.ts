// Đọc độ dài audio ngay trong renderer (file nhỏ) hoặc ước lượng theo dung lượng (file lớn/video).
import type { FileRef } from '../api/types';

export async function decodeDuration(ref: FileRef): Promise<{ durationSec: number; sampleRate: number; channels: number } | null> {
  if (!ref.file || ref.size > 80e6) return null;
  try {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await ref.file.arrayBuffer());
    void ctx.close();
    return { durationSec: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels };
  } catch {
    return null;
  }
}

export function estimateDuration(ref: FileRef): number {
  const ext = ref.name.split('.').pop()?.toLowerCase() ?? '';
  const bytesPerSec = ext === 'wav' ? 96_000 : ext === 'flac' ? 60_000 : 16_000;
  return ref.size / bytesPerSec;
}

