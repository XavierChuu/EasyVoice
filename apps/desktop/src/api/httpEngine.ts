// Client thật tới engine Python (spec mục 4): REST cho lệnh, WebSocket /ws/jobs cho tiến độ.
// Token gửi qua header Authorization; với <audio src> và WebSocket thì qua ?token= (không đặt được header).

import { decodeDuration, estimateDuration } from '../lib/audioMeta';
import { normalizePreview } from '../lib/normalize';
import { isElectron, platform } from '../lib/platform';
import type { components } from '../../../../packages/api-types/src/schema';
import type { EngineClient } from './engine';
import {
  EngineError,
  type AudioDevice, type DatasetFile, type DictEntry, type EditAsset, type EditOp, type EditProject, type EditProjectSummary,
  type EditTimeline, type EngineErrorCode, type EngineSettings, type SettingsUpdate, type EngineEvent, type ExportOptions,
  type FileRef, type ImportInspection, type RealtimeConfig, type RealtimeStats, type Recording, type Job, type PlaySource, type Profile, type RefAnalysis, type StsRequest,
  type SystemInfo, type TrainPreset, type TtsRequest, type VoiceLang, type VoiceTags, type VoiceUpdate,
} from './types';

type RealtimeWire = components['schemas']['RealtimeStatus'];

/** Số đo live từ engine → dạng UI dùng. */
const toStats = (s: RealtimeWire): RealtimeStats => ({
  running: s.running, inDb: s.inDb, outDb: s.outDb, latencyMs: Math.round(s.latencyMs), underrun: s.underrun,
  underruns: s.underruns, recording: s.recording, recordSec: s.recordSec, profileId: s.profileId, error: s.error,
});

export class HttpEngine implements EngineClient {
  readonly mode = 'sidecar' as const;
  private listeners = new Set<(ev: EngineEvent) => void>();
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private base: string, private token: string) {}

  /** Engine khởi động lại với port/token mới (sidecar tự restart). */
  rebind(base: string, token: string) {
    if (base === this.base && token === this.token) return;
    this.base = base;
    this.token = token;
    this.ws?.close();
  }

  // ---------- transport ----------
  private url(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  }

  private mediaUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    return this.url(path, { ...params, token: this.token }).toString();
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      });
    } catch {
      throw new EngineError('ENGINE_OFFLINE');
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new EngineError((data.code as EngineErrorCode) ?? 'UNKNOWN', data.detail || data.message);
    return data as T;
  }

  private download(path: string, params: Record<string, string>) {
    const a = document.createElement('a');
    a.href = this.mediaUrl(path, params);
    a.download = '';
    a.click();
  }

  private form(fields: Record<string, string | number | boolean>, files: [string, FileRef][]) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    for (const [k, ref] of files) {
      if (!ref.file) throw new EngineError('BAD_FILE', ref.name);
      fd.append(k, ref.file, ref.name);
    }
    return fd;
  }

  // ---------- events ----------
  subscribe(cb: (ev: EngineEvent) => void) {
    this.listeners.add(cb);
    if (!this.ws) this.connect();
    if (!this.poll) {
      this.poll = setInterval(() => void this.system().then((system) => this.emit({ type: 'system', system })).catch(() => {}), 3000);
    }
    return () => this.listeners.delete(cb);
  }

  private emit(ev: EngineEvent) {
    for (const l of this.listeners) l(ev);
  }

  private connect() {
    if (this.closed) return;
    const u = this.url('/ws/jobs', { token: this.token });
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(u);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; };
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data as string);
      if (ev.type === 'job') this.emit({ type: 'job', job: ev.job as Job });
      else if (ev.type === 'voices') this.emit({ type: 'voices', voices: ev.voices as Profile[] });
      else if (ev.type === 'realtime') this.emit({ type: 'realtime', stats: toStats(ev.stats as RealtimeWire) });
    };
    ws.onclose = () => {
      this.ws = null;
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay); // engine đang khởi động / khởi động lại
    };
  }

  // ---------- system ----------
  system = () => this.req<SystemInfo>('GET', '/system/info');
  getSettings = () => this.req<EngineSettings>('GET', '/system/settings');
  updateSettings = (patch: Partial<SettingsUpdate>) => this.req<EngineSettings>('PUT', '/system/settings', patch);
  health = () => this.req<{ status: string; version: string }>('GET', '/system/health');
  downloadModels = async (ids: string[]) => (await this.req<{ jobId: string }>('POST', '/models/download', { ids })).jobId;

  // ---------- voices ----------
  listVoices = () => this.req<Profile[]>('GET', '/voices');
  analyzeRef = (file: FileRef) => this.req<RefAnalysis>('POST', '/voices/analyze', this.form({}, [['file', file]]));

  async analyzeDataset(files: FileRef[]): Promise<DatasetFile[]> {
    const out: DatasetFile[] = [];
    for (const ref of files) out.push({ ref, durationSec: (await decodeDuration(ref))?.durationSec ?? estimateDuration(ref) });
    return out;
  }

  transcribe = async (file: FileRef, lang: VoiceLang) =>
    (await this.req<{ text: string }>('POST', '/voices/transcribe', this.form({ language: lang }, [['file', file]]))).text;

  createQuickVoice = (input: { name: string; language: VoiceLang; file: FileRef; transcript: string; consent: true; tags?: VoiceTags }) => {
    const tags = Object.fromEntries(Object.entries(input.tags ?? {}).filter(([, v]) => v)) as Record<string, string>;
    return this.req<Profile>('POST', '/voices', this.form(
      { name: input.name, language: input.language, transcript: input.transcript, consent: true, ...tags }, [['file', input.file]],
    ));
  };

  /** App desktop gửi đường dẫn file (engine chạy cùng máy, file dataset có thể rất lớn); trình duyệt thì upload. */
  startTraining = (input: {
    name: string; language: VoiceLang; files: FileRef[]; separate: boolean; preset: TrainPreset; consent: true; tags?: VoiceTags;
  }) => {
    const local = isElectron() ? input.files.filter((f) => /^([a-zA-Z]:[\\/]|\/)/.test(f.path)) : [];
    const upload = input.files.filter((f) => !local.includes(f));
    const tags = Object.fromEntries(Object.entries(input.tags ?? {}).filter(([, v]) => v)) as Record<string, string>;
    return this.req<Profile>('POST', '/train', this.form(
      { name: input.name, language: input.language, preset: input.preset, separate: input.separate, consent: true,
        paths: JSON.stringify(local.map((f) => f.path)), ...tags },
      upload.map((f) => ['files', f]),
    ));
  };
  updateVoice = async (id: string, patch: VoiceUpdate) => { await this.req('PATCH', `/voices/${id}`, patch); };
  deleteVoice = async (id: string) => { await this.req('DELETE', `/voices/${id}`); };
  previewVoice = async (id: string, variantId?: string): Promise<PlaySource> =>
    ({ durationSec: 8, url: this.mediaUrl(`/voices/${id}/preview`, { variant: variantId }) });

  addVariant = (voiceId: string, input: { name: string; emotion: string | null; file: FileRef; transcript: string }) =>
    this.req<Profile>('POST', `/voices/${voiceId}/variants`, this.form(
      { name: input.name, transcript: input.transcript, ...(input.emotion ? { emotion: input.emotion } : {}) }, [['file', input.file]],
    ));

  deleteVariant = async (voiceId: string, variantId: string) => { await this.req('DELETE', `/voices/${voiceId}/variants/${variantId}`); };

  inspectImport = (files: FileRef[]) => this.req<ImportInspection>('POST', '/voices/import/inspect', this.form({}, files.map((f) => ['files', f])));
  importVoice = (token: string, name: string) => this.req<Profile>('POST', '/voices/import', { token, name });
  /** Xuất .evoice vào thư mục Tải về của máy (engine chạy cùng máy nên ghi thẳng file, trả đường dẫn). */
  exportVoice = async (id: string, opts: ExportOptions) => {
    const { downloads } = await platform.appPaths();
    const r = await this.req<{ path: string; sizeMb: number; fileId: string }>('POST', `/voices/${id}/export`, {
      includeModel: opts.includeModel, includeRef: opts.includeRef, license: opts.license, author: opts.author,
      destDir: isElectron() ? downloads : null,
    });
    // Trình duyệt (dev): không mở được thư mục trên máy → tải file về qua engine
    if (!isElectron()) this.download(`/files/${r.fileId}`, { download: 'true' });
    return { path: r.path, sizeMb: r.sizeMb };
  };
  estimateExport = (_id: string, opts: { includeModel: boolean; includeRef: boolean }) =>
    (opts.includeModel ? 142.6 : 0) + (opts.includeRef ? 1.6 : 0) + 0.4;

  // ---------- TTS ----------
  normalizePreview = (text: string, lang: VoiceLang, dict: DictEntry[]) => normalizePreview(text, lang, dict);

  startTts = async (req: TtsRequest) => (await this.req<{ jobId: string }>('POST', '/tts', {
    profileId: req.profileId, variantId: req.variantId ?? null, parts: req.parts ?? [], text: req.text, mode: req.mode, speed: req.speed, seed: req.seed, pauseMs: req.pauseMs,
    userDict: req.dict.map((d) => [d.from, d.to]),
  })).jobId;

  redoSentence = async (jobId: string, index: number) => { await this.req('POST', `/tts/${jobId}/redo`, { index }); };

  async exportTts(jobId: string, format: 'wav' | 'mp3' | 'flac' | 'srt') {
    this.download(`/tts/${jobId}/export`, { format });
    return '';
  }

  ttsAudio = async (jobId: string, index?: number): Promise<PlaySource> => ({
    durationSec: 0, url: this.mediaUrl(`/tts/${jobId}/audio`, { index, t: Date.now() }),
  });

  // ---------- STS ----------
  startSts = async (req: StsRequest) => (await this.req<{ jobId: string }>('POST', '/sts/offline', this.form({
    profileId: req.profileId, pitch: req.pitch, indexRate: req.indexRate, protect: req.protect, separate: req.separate,
  }, [['file', req.file]]))).jobId;

  async exportSts(jobId: string) {
    this.download(`/sts/${jobId}/audio`, { which: 'b', download: 'true' });
    return '';
  }

  stsAudio = async (jobId: string, which: 'a' | 'b'): Promise<PlaySource> => ({ durationSec: 0, url: this.mediaUrl(`/sts/${jobId}/audio`, { which }) });

  // ---------- Edit Audio ----------
  listEditProjects = () => this.req<EditProjectSummary[]>('GET', '/edit/projects');
  createEditProject = (name: string) => this.req<EditProject>('POST', '/edit/projects', { name });
  getEditProject = (id: string, gc = false) => this.req<EditProject>('GET', `/edit/projects/${id}${gc ? '?gc=true' : ''}`);
  saveEditProject = (id: string, timeline: EditTimeline) => this.req<EditProject>('PUT', `/edit/projects/${id}`, timeline);
  deleteEditProject = async (id: string) => { await this.req('DELETE', `/edit/projects/${id}`); };
  editAssets = (id: string) => this.req<EditAsset[]>('GET', `/edit/projects/${id}/assets`);

  /** Như train: app desktop gửi đường dẫn file trên máy (video dài không cần đọc vào renderer), còn lại upload. */
  addEditAssets = (id: string, files: FileRef[], source: 'import' | 'record') => {
    const local = isElectron() ? files.filter((f) => !f.file && /^([a-zA-Z]:[\\/]|\/)/.test(f.path)) : [];
    const upload = files.filter((f) => !local.includes(f));
    return this.req<EditAsset[]>('POST', `/edit/projects/${id}/assets`, this.form(
      { source, paths: JSON.stringify(local.map((f) => f.path)) }, upload.map((f) => ['files', f]),
    ));
  };

  editAssetUrl = (projectId: string, assetId: string) => this.mediaUrl(`/edit/projects/${projectId}/assets/${assetId}/audio`);
  editFromJob = (jobId: string) => this.req<EditProject>('POST', '/edit/projects/from-job', { jobId });
  editOp = async (projectId: string, op: EditOp) => (await this.req<{ jobId: string }>('POST', `/edit/projects/${projectId}/ops`, op)).jobId;
  downloadFile = async (fileId: string) => this.download(`/files/${fileId}`, { download: 'true' });

  // ---------- jobs ----------
  cancelJob = async (id: string) => { await this.req('DELETE', `/jobs/${id}`); };
  resumeJob = async (id: string) => { await this.req('POST', `/jobs/${id}/resume`); };

  // ---------- real-time (Phase 4) ----------
  audioDevices = () => this.req<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>('GET', '/audio/devices');

  startRealtime = async (cfg: RealtimeConfig) => {
    const st = await this.req<RealtimeWire>('POST', '/realtime/start', {
      profileId: cfg.profileId, inputId: cfg.inputId, outputId: cfg.outputId || null, preset: cfg.preset,
      blockMs: cfg.blockMs, contextSec: cfg.contextSec, crossfadeMs: cfg.crossfadeMs, pitch: cfg.pitch, gateDb: cfg.gateDb,
      record: !!cfg.record, preloadProfileIds: cfg.preloadProfileIds ?? [],
    });
    this.emit({ type: 'realtime', stats: toStats(st) });
  };

  updateRealtime = async (patch: Partial<Pick<RealtimeConfig, 'pitch' | 'gateDb' | 'profileId'>>) => {
    const st = await this.req<RealtimeWire>('PATCH', '/realtime', patch);
    this.emit({ type: 'realtime', stats: toStats(st) });
  };

  stopRealtime = async () => (await this.req<{ recording: Recording | null }>('POST', '/realtime/stop')).recording;
  setRealtimeRecording = async (on: boolean) => (await this.req<{ recording: Recording | null }>('POST', '/realtime/record', { on })).recording;
  listRecordings = () => this.req<Recording[]>('GET', '/realtime/recordings');
  deleteRecording = async (id: string) => { await this.req('DELETE', `/realtime/recordings/${id}`); };
  recordingAudio = (id: string): PlaySource => ({ durationSec: 0, url: this.mediaUrl(`/realtime/recordings/${id}/audio`) });
  editFromFile = (fileId: string) => this.req<EditProject>('POST', '/edit/projects/from-file', { fileId });
}
