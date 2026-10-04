// Interface UI dùng để nói chuyện với engine. Bản thật (HTTP + WebSocket tới sidecar, spec mục 4) sẽ thay
// MockEngine khi engine có ở Phase 1-2; UI không cần đổi.

import { MockEngine } from './mockEngine';
import type {
  AudioDevice, DatasetFile, DictEntry, EngineEvent, ExportOptions, FileRef, ImportInspection, Profile,
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
  createQuickVoice(input: { name: string; language: VoiceLang; file: FileRef; transcript: string; consent: true }): Promise<Profile>;
  startTraining(input: {
    name: string; language: VoiceLang; files: FileRef[]; separate: boolean; preset: TrainPreset; consent: true;
  }): Promise<Profile>;
  renameVoice(id: string, name: string): Promise<void>;
  deleteVoice(id: string): Promise<void>;
  previewVoice(id: string): Promise<number>; // độ dài đoạn nghe thử (giây)

  inspectImport(files: FileRef[]): Promise<ImportInspection>;
  importVoice(token: string, name: string): Promise<Profile>;
  exportVoice(id: string, opts: ExportOptions): Promise<{ path: string; sizeMb: number }>;
  estimateExport(id: string, opts: Pick<ExportOptions, 'includeModel' | 'includeRef'>): number;

  normalizePreview(text: string, lang: VoiceLang, dict: DictEntry[]): DictEntry[];
  startTts(req: TtsRequest): Promise<string>;
  redoSentence(jobId: string, index: number): Promise<void>;
  exportTts(jobId: string, format: 'wav' | 'mp3' | 'flac' | 'srt'): Promise<string>;

  startSts(req: StsRequest): Promise<string>;
  exportSts(jobId: string): Promise<string>;

  cancelJob(id: string): Promise<void>;
  resumeJob(id: string): Promise<void>;

  audioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>;
  startRealtime(cfg: RealtimeConfig): Promise<void>;
  updateRealtime(patch: Partial<Pick<RealtimeConfig, 'pitch' | 'gateDb'>>): Promise<void>;
  stopRealtime(): Promise<void>;
}

let instance: EngineClient | null = null;

export function engine(): EngineClient {
  if (!instance) instance = new MockEngine();
  return instance;
}
