// Interface UI dùng để nói chuyện với engine. Bản thật (HTTP + WebSocket tới sidecar, spec mục 4) sẽ thay
// MockEngine khi engine có ở Phase 1-2; UI không cần đổi.

import type { EngineInfo } from '../lib/platform';
import { HttpEngine } from './httpEngine';
import { MockEngine } from './mockEngine';
import type {
  AudioDevice, DatasetFile, DictEntry, EngineEvent, ExportOptions, FileRef, ImportInspection, PlaySource, Profile, VoiceTags, VoiceUpdate,
  RealtimeConfig, RefAnalysis, StsRequest, SystemInfo, TrainPreset, TtsRequest, VoiceLang,
} from './types';

export interface EngineClient {
  readonly mode: 'mock' | 'sidecar';
  subscribe(cb: (ev: EngineEvent) => void): () => void;

  system(): Promise<SystemInfo>;
  downloadModels(ids: string[]): Promise<string>; // job id

  listVoices(): Promise<Profile[]>;
  analyzeRef(file: FileRef): Promise<RefAnalysis>;
  analyzeDataset(files: FileRef[]): Promise<DatasetFile[]>;
  transcribe(file: FileRef, lang: VoiceLang): Promise<string>;
  createQuickVoice(input: { name: string; language: VoiceLang; file: FileRef; transcript: string; consent: true; tags?: VoiceTags }): Promise<Profile>;
  startTraining(input: {
    name: string; language: VoiceLang; files: FileRef[]; separate: boolean; preset: TrainPreset; consent: true;
  }): Promise<Profile>;
  /** Đổi tên và/hoặc thẻ; chỉ trường có trong patch được đổi (null = xóa thẻ). */
  updateVoice(id: string, patch: VoiceUpdate): Promise<void>;
  deleteVoice(id: string): Promise<void>;
  /** Đoạn nghe thử của giọng (preview.wav / ref.wav) hoặc của một biến thể. */
  previewVoice(id: string, variantId?: string): Promise<PlaySource>;
  /** Biến thể cảm xúc của cùng người đọc: một đoạn ref + lời thoại riêng. */
  addVariant(voiceId: string, input: { name: string; emotion: string | null; file: FileRef; transcript: string }): Promise<Profile>;
  deleteVariant(voiceId: string, variantId: string): Promise<void>;

  inspectImport(files: FileRef[]): Promise<ImportInspection>;
  importVoice(token: string, name: string): Promise<Profile>;
  exportVoice(id: string, opts: ExportOptions): Promise<{ path: string; sizeMb: number }>;
  estimateExport(id: string, opts: Pick<ExportOptions, 'includeModel' | 'includeRef'>): number;

  normalizePreview(text: string, lang: VoiceLang, dict: DictEntry[]): DictEntry[];
  startTts(req: TtsRequest): Promise<string>;
  redoSentence(jobId: string, index: number): Promise<void>;
  exportTts(jobId: string, format: 'wav' | 'mp3' | 'flac' | 'srt'): Promise<string>;
  /** Audio của cả bài (index bỏ trống) hoặc một câu đã render xong. */
  ttsAudio(jobId: string, index?: number): Promise<PlaySource>;

  startSts(req: StsRequest): Promise<string>;
  exportSts(jobId: string): Promise<string>;
  /** a = audio gốc, b = audio đã đổi giọng. */
  stsAudio(jobId: string, which: 'a' | 'b'): Promise<PlaySource>;

  cancelJob(id: string): Promise<void>;
  resumeJob(id: string): Promise<void>;

  audioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>;
  startRealtime(cfg: RealtimeConfig): Promise<void>;
  /** profileId: đổi giọng đích khi đang live (giữ phím tắt 1-9). */
  updateRealtime(patch: Partial<Pick<RealtimeConfig, 'pitch' | 'gateDb' | 'profileId'>>): Promise<void>;
  stopRealtime(): Promise<void>;
}

let instance: EngineClient | null = null;

export function engine(): EngineClient {
  if (!instance) instance = new MockEngine();
  return instance;
}

/**
 * Chọn engine: sidecar do Electron khởi động (port + token qua preload) → HttpEngine;
 * chạy `npm run dev` trong trình duyệt với VITE_ENGINE_URL + VITE_ENGINE_TOKEN → HttpEngine;
 * không có engine → MockEngine (giả lập để dựng UI).
 */
export function connectEngine(info: EngineInfo): EngineClient {
  const env = import.meta.env as Record<string, string | undefined>;
  let target: { base: string; token: string } | null = null;
  if (info.port && info.token && info.status !== 'mock') target = { base: `http://127.0.0.1:${info.port}`, token: info.token };
  else if (env.VITE_ENGINE_URL && env.VITE_ENGINE_TOKEN) target = { base: env.VITE_ENGINE_URL, token: env.VITE_ENGINE_TOKEN };
  if (target) {
    if (instance instanceof HttpEngine) instance.rebind(target.base, target.token);
    else instance = new HttpEngine(target.base, target.token);
  }
  return engine();
}
