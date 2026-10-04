// Kiểu dữ liệu giữa UI và engine.
// TẠM THỜI viết tay để dựng UI với mock engine. Khi engine (FastAPI) có OpenAPI ở Phase 1-2, thay bằng
// types sinh tự động trong packages/api-types (quy tắc mục 10: không viết tay types API).

export type VoiceLang = 'vi' | 'en' | 'unknown';
export type Capability = 'tts' | 'sts';
export type LicenseId = 'personal' | 'commercial' | 'noredist' | 'unknown';
export type TrainPreset = 'fast' | 'balanced' | 'thorough';
export type TrainStage = 'preprocess' | 'extract' | 'train' | 'index';
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type JobKind = 'tts' | 'sts' | 'train' | 'download';

export interface FileRef {
  path: string;
  name: string;
  size: number;
  /** Chỉ có khi chạy trong trình duyệt (fallback) hoặc file thu âm. */
  file?: File;
}

export interface Profile {
  id: string;
  name: string;
  language: VoiceLang;
  createdAt: string; // ISO
  capabilities: Capability[];
  /** Job train RVC đang gắn với profile (null khi không train). */
  trainJobId: string | null;
  imported: boolean;
  author?: string;
  license?: LicenseId;
  hasRef: boolean;
  sampleRate?: number;
}

export interface RefAnalysis {
  durationSec: number;
  sampleRate: number;
  channels: number;
  checks: { key: 'trim' | 'loudness' | 'music' | 'noise'; ok: boolean }[];
  warnings: ('too_short' | 'too_long' | 'music' | 'noise' | 'clipping')[];
}

export interface DatasetFile {
  ref: FileRef;
  durationSec: number;
}

export interface TtsSentence {
  index: number;
  text: string;
  status: 'queued' | 'rendering' | 'done' | 'redo';
  progress: number; // 0..1
  durationSec?: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number; // 0..1
  label: string;
  profileId?: string;
  stage?: TrainStage | StsStage | string;
  /** Job đang giữ GPU khiến job này phải chờ. */
  waitingFor?: string;
  log: string[];
  error?: EngineErrorCode;
  // train
  epoch?: number;
  totalEpochs?: number;
  // tts
  sentences?: TtsSentence[];
  // kết quả
  outputPath?: string;
  outputDurationSec?: number;
}

export type StsStage = 'demux' | 'separate' | 'prep' | 'convert' | 'remix' | 'join';

export interface ModelInfo {
  id: string;
  name: string;
  role: string;
  group: 'tts' | 'sts' | 'common';
  sizeMb: number;
  license: string;
  commercial: boolean | null;
  installed: boolean;
  required: boolean;
}

export interface SystemInfo {
  appVersion: string;
  gpu: string;
  device: string; // cuda:0 | mps | cpu
  vramTotalGb: number;
  vramUsedGb: number;
  diskFreeGb: number;
  driverOk: boolean;
  models: ModelInfo[];
}

export interface AudioDevice {
  id: string;
  name: string;
  virtual: boolean;
}

export interface RealtimeConfig {
  profileId: string;
  inputId: string;
  outputId: string;
  preset: 'low' | 'balanced' | 'quality';
  blockMs: number;
  contextSec: number;
  crossfadeMs: number;
  pitch: number;
  gateDb: number;
}

export interface RealtimeStats {
  running: boolean;
  inDb: number;
  outDb: number;
  latencyMs: number;
  underrun: boolean;
  underruns: number;
}

export interface ImportInspection {
  token: string;
  kind: 'evoice' | 'rvc';
  fileLabel: string;
  blocked: boolean;
  checks: { key: string; value: string; bad?: boolean }[];
  suggestedName: string;
  author: string;
  language: VoiceLang;
  license: LicenseId;
  capabilities: Capability[];
  createdAt?: string;
  sampleRate: number;
}

export interface ExportOptions {
  includeModel: boolean;
  includeRef: boolean;
  license: Exclude<LicenseId, 'unknown'>;
  author: string;
}

export interface TtsRequest {
  profileId: string;
  text: string;
  mode: 'direct' | 'chain';
  speed: number;
  seed: number;
  pauseMs: number;
}

export interface StsRequest {
  profileId: string;
  file: FileRef;
  pitch: number;
  indexRate: number;
  protect: number;
  separate: boolean;
}

export interface DictEntry {
  from: string;
  to: string;
}

export type EngineErrorCode =
  | 'GPU_BUSY_REALTIME'
  | 'GPU_BUSY_JOB'
  | 'GPU_OOM'
  | 'NO_STS_VOICE'
  | 'UNSAFE_MODEL'
  | 'BAD_FILE'
  | 'ENGINE_OFFLINE'
  | 'MODEL_MISSING'
  | 'UNKNOWN';

export class EngineError extends Error {
  constructor(public readonly code: EngineErrorCode, detail?: string) {
    super(detail ?? code);
  }
}

export type EngineEvent =
  | { type: 'voices'; voices: Profile[] }
  | { type: 'job'; job: Job }
  | { type: 'realtime'; stats: RealtimeStats }
  | { type: 'system'; system: SystemInfo };
