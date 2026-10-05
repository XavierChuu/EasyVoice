// Kiểu dữ liệu giữa UI và engine.
// Các kiểu của API lấy từ types SINH TỰ ĐỘNG theo OpenAPI của engine (packages/api-types — quy tắc mục 10).
// Chỉ các kiểu thuần UI hoặc của tính năng chưa có trong API (real-time Phase 4, xuất .evoice Phase 5) viết ở đây.

import type { components } from '../../../../packages/api-types/src/schema';

type S = components['schemas'];

export type Profile = S['Profile'];
export type Job = S['Job'];
export type JobStatus = Job['status'];
export type JobKind = Job['kind'];
export type TtsSentence = S['TtsSentence'];
export type RefAnalysis = S['RefAnalysis'];
export type ImportInspection = S['ImportInspection'];
export type ModelInfo = S['ModelInfo'];
export type SystemInfo = S['SystemInfo'];
export type AudioDevice = S['AudioDevice'];
export type Variant = S['VariantInfo'];
export type TtsPart = S['TtsPart'];
export type VoiceUpdate = S['VoiceUpdate'];
export type EditProject = S['EditProject'];
export type EditProjectSummary = S['EditProjectSummary'];
export type EditAsset = S['EditAsset'];
export type EditWord = S['EditWord'];
export type SpeakerTurn = S['SpeakerTurn'];
export type EditClip = S['EditClip-Output'];
export type EditTrack = S['EditTrack-Output'];
export type EditSpeaker = S['EditSpeaker'];
export type EditTimeline = Pick<EditProject, 'name' | 'tracks' | 'clips' | 'speakers' | 'ripple'>;
export type EditSegment = S['Segment'];
export type EditOp =
  | S['TranscribeOp'] | S['DiarizeOp'] | S['SeparateOp'] | S['FilterOp'] | S['ConvertOp'] | S['RetextOp'] | S['SpeakOp']
  | S['SilencesOp'] | S['DuckOp'] | S['RenderOp'];
export type EditFilter = S['FilterOp']['filter'];
/** Kết quả (job.result) của từng thao tác Edit Audio — engine trả dạng dữ liệu tự do nên khai báo ở đây. */
export interface EditOpResult {
  assets?: string[];
  replaceOffset?: number;
  replaceDuration?: number;
  pairs?: Record<string, [string, string]>;
  speakers?: number;
  base?: number;
  embedder?: string;
  words?: number;
  ranges?: [number, number][];
  tracks?: Record<string, string>;
  file?: string;
  srt?: string;
  lufs?: number | null;
  peakDb?: number | null;
  durationSec?: number;
}
export type Gender = NonNullable<Profile['gender']>;
/** Thẻ phân loại giọng (giới tính, mã quốc gia ISO, vùng miền). */
export type VoiceTags = Pick<Profile, 'gender' | 'country' | 'region'>;
export type VoiceLang = Profile['language'];
export type Capability = Profile['capabilities'][number];
export type LicenseId = Profile['license'];

export type TrainPreset = 'fast' | 'balanced' | 'thorough';
export type TrainStage = 'preprocess' | 'extract' | 'train' | 'index';

export interface FileRef {
  path: string;
  name: string;
  size: number;
  /** Chỉ có khi chạy trong trình duyệt (fallback) hoặc file thu âm. */
  file?: File;
}



export interface DatasetFile {
  ref: FileRef;
  durationSec: number;
}



export type StsStage = 'demux' | 'separate' | 'prep' | 'convert' | 'remix' | 'join';




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


export interface ExportOptions {
  includeModel: boolean;
  includeRef: boolean;
  license: Exclude<LicenseId, 'unknown'>;
  author: string;
}

export interface TtsRequest {
  profileId: string;
  /** Biến thể của giọng chính; bỏ trống = giọng chuẩn. */
  variantId?: string | null;
  text: string;
  /** Các đoạn gán giọng riêng (bôi đen → chuột phải). Bỏ trống = cả văn bản đọc bằng giọng chính. */
  parts?: TtsPart[];
  mode: 'direct' | 'chain';
  speed: number;
  seed: number;
  pauseMs: number;
  dict: DictEntry[];
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
  | 'NOT_IMPLEMENTED'
  | 'GPU_REQUIRED'
  | 'DOWNLOAD_FAILED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'UNKNOWN';

export class EngineError extends Error {
  constructor(public readonly code: EngineErrorCode, detail?: string) {
    super(detail ?? code);
  }
}

/** Nguồn phát: url (file WAV engine trả về) hoặc speak (mock: giọng hệ thống). */
export interface PlaySource {
  durationSec: number;
  url?: string;
  speak?: { texts: string[]; lang: string; rate: number };
}

export type EngineEvent =
  | { type: 'voices'; voices: Profile[] }
  | { type: 'job'; job: Job }
  | { type: 'realtime'; stats: RealtimeStats }
  | { type: 'system'; system: SystemInfo };
