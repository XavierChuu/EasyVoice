// Mock engine: giả lập engine Python (JobQueue, ModelManager, real-time) để dựng và test UI trước Phase 1.
// Quy tắc mô phỏng theo spec: mỗi lúc 1 job GPU nặng; real-time giữ GPU độc quyền; hủy train = dừng và giữ
// checkpoint để resume.

import { decodeDuration, estimateDuration } from '../lib/audioMeta';
import { normalizePreview } from '../lib/normalize';
import { osName, platform } from '../lib/platform';
import { slugify, splitSentences } from '../lib/text';
import { downloadBlob, encodeWav } from '../lib/wav';
import type { EngineClient } from './engine';
import {
  EngineError,
  type AudioDevice, type DatasetFile, type DictEntry, type EditAsset, type EditOp, type EditProject, type EditProjectSummary,
  type EditTimeline, type EngineEvent, type EngineSettings, type SettingsUpdate, type ExportOptions, type FileRef,
  type ImportInspection, type Job, type ModelInfo, type PlaySource, type Profile, type RealtimeConfig, type RealtimeStats, type Recording,
  type RefAnalysis, type StsRequest, type StsStage, type SystemInfo, type TrainPreset, type TrainStage,
  type TtsRequest, type VoiceLang, type VoiceTags, type VoiceUpdate,
} from './types';

const TICK_MS = 120;
const HEAVY: Job['kind'][] = ['tts', 'sts', 'train'];
const EPOCHS: Record<TrainPreset, number> = { fast: 100, balanced: 200, thorough: 400 };
const MODELS_KEY = 'ev.mock.models';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

const mkProfile = (p: Partial<Profile> & Pick<Profile, 'id' | 'name' | 'language' | 'createdAt' | 'capabilities'>): Profile => ({
  trainJobId: null, imported: false, author: null, license: 'personal', hasRef: true, hasPreview: p.hasRef ?? true, sampleRate: null,
  variants: [], gender: null, country: null, region: null, ...p,
});

const ok = (key: string, value: string, bad = false) => ({ key, value, bad });

export function trainStage(p: number): TrainStage {
  return p < 0.15 ? 'preprocess' : p < 0.3 ? 'extract' : p < 0.92 ? 'train' : 'index';
}

const MODEL_CATALOG: Omit<ModelInfo, 'installed'>[] = [
  { id: 'f5-vi', name: 'F5-TTS Vietnamese', role: 'Text to Speech', group: 'tts', sizeMb: 1350, license: 'CC-BY-NC-4.0', commercial: false, required: true, languages: ['vi', 'en'] },
  { id: 'vocos', name: 'Vocos mel 24 kHz', role: 'Vocoder', group: 'tts', sizeMb: 52, license: 'MIT', commercial: true, required: true, languages: null },
  { id: 'whisper-small', name: 'Whisper small (faster-whisper)', role: 'Transcript', group: 'tts', sizeMb: 470, license: 'MIT', commercial: true, required: false, languages: null },
  { id: 'contentvec', name: 'ContentVec base', role: 'Voice Changer · encoder', group: 'sts', sizeMb: 360, license: 'MIT', commercial: true, required: true, languages: null },
  { id: 'rmvpe', name: 'RMVPE', role: 'Voice Changer · pitch', group: 'sts', sizeMb: 173, license: 'MIT', commercial: true, required: true, languages: null },
  { id: 'rvc-pretrained', name: 'RVC v2 pretrained 40k', role: 'Voice training', group: 'sts', sizeMb: 110, license: 'MIT', commercial: true, required: false, languages: null },
  { id: 'demucs', name: 'Demucs htdemucs', role: 'Music separation', group: 'common', sizeMb: 320, license: 'MIT', commercial: true, required: false, languages: null },
];

function loadInstalled(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(MODELS_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveInstalled(ids: Set<string>) {
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify([...ids]));
  } catch {
    /* private mode */
  }
}

export class MockEngine implements EngineClient {
  readonly mode = 'mock' as const;
  private listeners = new Set<(ev: EngineEvent) => void>();
  private voices: Profile[];
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private presetOf = new Map<string, TrainPreset>();
  private stsStages = new Map<string, StsStage[]>();
  private imports = new Map<string, ImportInspection>();
  private installed = loadInstalled();
  private rt: { cfg: RealtimeConfig | null; stats: RealtimeStats } = {
    cfg: null,
    stats: { running: false, inDb: -120, outDb: -120, latencyMs: 0, underrun: false, underruns: 0 },
  };
  private ticks = 0;
  /** Audio thật của mock: ref người dùng chọn/thu, file STS gốc và bản "đổi giọng" giả lập. */
  private refAudio = new Map<string, FileRef>();
  private ttsReq = new Map<string, { lang: string; rate: number }>();
  private stsIn = new Map<string, { file: FileRef; pitch: number }>();
  private stsOut = new Map<string, { blob: Blob; url: string; durationSec: number }>();

  constructor() {
    this.voices = [
      mkProfile({
        id: 'p1', name: 'My Voice', language: 'vi', createdAt: daysAgo(2), capabilities: ['tts', 'sts'], sampleRate: 40000,
        gender: 'male', country: 'VN', region: 'north',
        variants: [
          { id: 'v1', name: 'Vui vẻ', emotion: 'happy', createdAt: daysAgo(1) },
          { id: 'v2', name: 'Giận dữ', emotion: 'angry', createdAt: daysAgo(1) },
        ],
      }),
      mkProfile({ id: 'p2', name: 'Warm Newsreader', language: 'vi', createdAt: daysAgo(6), capabilities: ['tts'], gender: 'female', country: 'VN', region: 'south' }),
      mkProfile({ id: 'p3', name: 'Narrator EN', language: 'en', createdAt: daysAgo(13), capabilities: ['tts', 'sts'], sampleRate: 40000, gender: 'male', country: 'GB' }),
      mkProfile({ id: 'p4', name: 'Cartoon Character', language: 'vi', createdAt: daysAgo(0), capabilities: ['tts'], gender: 'other', country: 'VN', region: 'central' }),
    ];
    const train = this.newJob('train', 'Cartoon Character', 'p4');
    train.progress = 0.62;
    train.totalEpochs = EPOCHS.balanced;
    train.log.push('Dataset: 3 files · 17:57 total · 16:40 clean', 'Preprocess done · 412 segments', 'Features extracted (ContentVec + RMVPE)');
    this.presetOf.set(train.id, 'balanced');
    this.voices[3].trainJobId = train.id;
    this.enqueue(train);
    setInterval(() => this.tick(), TICK_MS);
  }

  // ---------- events ----------
  subscribe(cb: (ev: EngineEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(ev: EngineEvent) {
    for (const l of this.listeners) l(ev);
  }

  private emitVoices() {
    this.emit({ type: 'voices', voices: this.voices.map((v) => ({ ...v, capabilities: [...v.capabilities] })) });
  }

  private emitJob(job: Job) {
    this.emit({ type: 'job', job: { ...job, log: [...job.log], files: { ...job.files }, sentences: job.sentences ? job.sentences.map((s) => ({ ...s })) : null } });
  }

  // ---------- jobs ----------
  private newJob(kind: Job['kind'], label: string, profileId?: string): Job {
    const job: Job = {
      id: uid('j'), kind, status: 'queued', progress: 0, label, profileId: profileId ?? null, stage: null, waitingFor: null,
      log: [], error: null, errorDetail: null, device: null, epoch: null, totalEpochs: null, sentences: null, files: {},
      outputDurationSec: null, result: null, createdAt: Date.now() / 1000,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private running(): Job | undefined {
    return [...this.jobs.values()].find((j) => HEAVY.includes(j.kind) && j.status === 'running');
  }

  private enqueue(job: Job) {
    job.status = 'queued';
    this.queue.push(job.id);
    this.schedule();
    this.emitJob(job);
  }

  private schedule() {
    const cur = this.running();
    if (!cur && !this.rt.stats.running && this.queue.length) {
      const next = this.jobs.get(this.queue.shift()!);
      if (next) {
        next.status = 'running';
        next.waitingFor = null;
        this.emitJob(next);
      }
    }
    const holder = this.running()?.label ?? (this.rt.stats.running ? 'Real-time' : null);
    for (const id of this.queue) {
      const j = this.jobs.get(id);
      if (j && j.waitingFor !== holder) {
        j.waitingFor = holder;
        this.emitJob(j);
      }
    }
  }

  private finish(job: Job, status: Job['status']) {
    job.status = status;
    if (status === 'done') job.progress = 1;
    this.emitJob(job);
    this.schedule();
  }

  private tick() {
    this.ticks++;
    const job = this.running();
    if (job) {
      if (job.kind === 'train') this.tickTrain(job);
      else if (job.kind === 'tts') this.tickTts(job);
      else if (job.kind === 'sts') this.tickSts(job);
    }
    for (const j of this.jobs.values()) if (j.kind === 'download' && j.status === 'running') this.tickDownload(j);
    if (this.rt.stats.running) this.tickRealtime();
    if (this.ticks % 8 === 0) void this.system().then((system) => this.emit({ type: 'system', system }));
  }

  private tickTrain(job: Job) {
    const before = trainStage(job.progress);
    job.progress = Math.min(1, job.progress + 0.003);
    const stage = trainStage(job.progress);
    job.stage = stage;
    const total = job.totalEpochs ?? 200;
    if (stage === 'train') {
      const epoch = Math.max(1, Math.round(((job.progress - 0.3) / 0.62) * total));
      if (epoch !== job.epoch && epoch % 10 === 0) job.log.push(`epoch ${epoch}/${total} · loss_mel ${(28 - epoch / total * 9).toFixed(2)} · checkpoint saved`);
      job.epoch = epoch;
    }
    if (stage !== before) {
      const msg: Record<TrainStage, string> = {
        preprocess: 'Preprocess: convert, separate vocals, denoise, slice',
        extract: 'Preprocess done · extracting features (ContentVec + RMVPE)',
        train: `Training · preset ${this.presetOf.get(job.id) ?? 'balanced'} · ${total} epochs`,
        index: 'Training done · building faiss index + preview',
      };
      job.log.push(msg[stage]);
    }
    if (job.progress >= 1) {
      job.log.push('Done · model.safetensors + model.index');
      const v = this.voices.find((p) => p.id === job.profileId);
      if (v) {
        if (!v.capabilities.includes('sts')) v.capabilities.push('sts');
        v.trainJobId = null;
        v.sampleRate = 40000;
        this.emitVoices();
      }
      this.finish(job, 'done');
      return;
    }
    this.emitJob(job);
  }

  private tickTts(job: Job) {
    const list = job.sentences ?? [];
    const cur = list.find((s) => s.status === 'redo' || s.status === 'rendering') ?? list.find((s) => s.status === 'queued');
    if (!cur) {
      job.outputDurationSec = list.reduce((a, s) => a + (s.durationSec ?? 0), 0);
      this.finish(job, 'done');
      return;
    }
    if (cur.status === 'queued') cur.status = 'rendering';
    cur.progress = Math.min(1, cur.progress + 0.12);
    if (cur.progress >= 1) {
      cur.status = 'done';
      cur.durationSec = Math.max(0.6, cur.text.length / 14);
    }
    job.progress = list.filter((s) => s.status === 'done').length / list.length;
    this.emitJob(job);
  }

  private tickSts(job: Job) {
    job.progress = Math.min(1, job.progress + 0.012);
    const stages = this.stsStages.get(job.id) ?? [];
    job.stage = stages[Math.min(stages.length - 1, Math.floor(job.progress * stages.length))];
    if (job.progress >= 1) {
      job.files.output = job.label.replace(/\.[^.]+$/, '') + '-converted.wav';
      void this.renderStsMock(job.id).finally(() => this.finish(job, 'done'));
      job.progress = 0.999;
      return;
    }
    this.emitJob(job);
  }

  private tickDownload(job: Job) {
    job.progress = Math.min(1, job.progress + 0.01);
    if (job.progress >= 1) {
      for (const m of MODEL_CATALOG) if (job.label.split(',').includes(m.id)) this.installed.add(m.id);
      saveInstalled(this.installed);
      job.status = 'done';
    }
    this.emitJob(job);
  }

  private tickRealtime() {
    const cfg = this.rt.cfg!;
    const quiet = Math.random() < 0.2;
    const lvl = quiet ? Math.random() * 12 : 35 + Math.random() * 60;
    const toDb = (l: number) => (l <= 0.5 ? -120 : 20 * Math.log10(l / 100));
    const inDb = toDb(lvl);
    const gated = inDb < cfg.gateDb;
    const outLvl = gated ? 0 : Math.max(0, Math.min(100, lvl - 6 + Math.random() * 8));
    const underrun = cfg.blockMs <= 100 && Math.random() < 0.1;
    this.rt.stats = {
      running: true,
      inDb,
      outDb: toDb(outLvl),
      latencyMs: Math.round(cfg.blockMs + 90 + Math.random() * 25),
      underrun,
      underruns: this.rt.stats.underruns + (underrun ? 1 : 0),
    };
    this.emit({ type: 'realtime', stats: { ...this.rt.stats } });
  }

  // ---------- system ----------
  async system(): Promise<SystemInfo> {
    let vram = 1.2;
    const cur = this.running();
    if (cur?.kind === 'train') vram += 4.6;
    if (cur?.kind === 'tts') vram += 3.1;
    if (cur?.kind === 'sts') vram += 2.8;
    if (this.rt.stats.running) vram += 2.4;
    const mac = osName() === 'mac';
    return {
      appVersion: '0.1.0',
      gpu: mac ? 'Apple M2 Pro' : 'RTX 3060',
      device: mac ? 'mps' : 'cuda:0',
      vramTotalGb: mac ? 16 : 12,
      vramUsedGb: Math.min(vram, 11.6),
      diskFreeGb: 184,
      driverOk: true,
      realtime: this.rt.stats.running,
      loadedModels: [],
      models: MODEL_CATALOG.map((m) => ({ ...m, installed: this.installed.has(m.id) })),
    };
  }

  private settings: EngineSettings = { device: 'auto', modelsDir: '', voicesDir: '', activeModelsDir: '~/EasyVoice/models',
    activeVoicesDir: '~/EasyVoice/voices', restartRequired: false };

  async getSettings() {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<SettingsUpdate>) {
    this.settings = { ...this.settings, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)) };
    return { ...this.settings };
  }

  async downloadModels(ids: string[]) {
    const job = this.newJob('download', ids.join(','));
    job.status = 'running';
    this.emitJob(job);
    return job.id;
  }

  // ---------- voices ----------
  async listVoices() {
    return this.voices.map((v) => ({ ...v }));
  }

  async analyzeRef(file: FileRef): Promise<RefAnalysis> {
    await sleep(400);
    const d = (await decodeDuration(file)) ?? { durationSec: 8.4, sampleRate: 48000, channels: 1 };
    const warnings: RefAnalysis['warnings'] = [];
    if (d.durationSec < 5) warnings.push('too_short');
    if (d.durationSec > 12) warnings.push('too_long');
    if (/music|nhac|song/i.test(file.name)) warnings.push('music');
    return {
      ...d,
      checks: [
        { key: 'trim', ok: true },
        { key: 'loudness', ok: true },
        { key: 'music', ok: !warnings.includes('music') },
      ],
      warnings,
    };
  }

  async analyzeDataset(files: FileRef[]): Promise<DatasetFile[]> {
    const out: DatasetFile[] = [];
    for (const ref of files) out.push({ ref, durationSec: (await decodeDuration(ref))?.durationSec ?? estimateDuration(ref) });
    return out;
  }

  async transcribe(_file: FileRef, lang: VoiceLang) {
    await sleep(1200);
    return lang === 'vi'
      ? 'Xin chào mọi người, hôm nay mình sẽ hướng dẫn một công thức rất đơn giản.'
      : 'Hi everyone, today I will show you a really simple recipe.';
  }

  async createQuickVoice(input: { name: string; language: VoiceLang; file: FileRef; transcript: string; tags?: VoiceTags }) {
    await sleep(800);
    const p = mkProfile({
      id: uid('p'), name: input.name, language: input.language, createdAt: new Date().toISOString(), capabilities: ['tts'],
      ...input.tags, country: input.tags?.country?.toUpperCase() || null,
    });
    this.refAudio.set(p.id, input.file);
    this.voices.unshift(p);
    this.emitVoices();
    return { ...p };
  }

  async startTraining(input: { name: string; language: VoiceLang; files: FileRef[]; separate: boolean; preset: TrainPreset }) {
    await sleep(300);
    const p = mkProfile({ id: uid('p'), name: input.name, language: input.language, createdAt: new Date().toISOString(), capabilities: ['tts'] });
    const job = this.newJob('train', input.name, p.id);
    job.totalEpochs = EPOCHS[input.preset];
    job.log.push(
      `Dataset: ${input.files.length} files${input.separate ? ' · music separation + denoise on' : ''}`,
      'Auto-selected a clean 9.2 s reference clip + Whisper transcript for Text to Speech',
    );
    this.presetOf.set(job.id, input.preset);
    const sample = input.files.find((f) => f.file && /^audio\//.test(f.file.type));
    if (sample) this.refAudio.set(p.id, sample);
    p.trainJobId = job.id;
    this.voices.unshift(p);
    this.emitVoices();
    this.enqueue(job);
    return { ...p };
  }

  async updateVoice(id: string, patch: VoiceUpdate) {
    const v = this.voices.find((p) => p.id === id);
    if (v) {
      if (patch.name) v.name = patch.name;
      if ('gender' in patch) v.gender = patch.gender ?? null;
      if ('country' in patch) v.country = patch.country?.toUpperCase() || null;
      if ('region' in patch) v.region = patch.region || null;
    }
    this.emitVoices();
  }

  async deleteVoice(id: string) {
    const v = this.voices.find((p) => p.id === id);
    if (v?.trainJobId) {
      const job = this.jobs.get(v.trainJobId);
      if (job) {
        this.queue = this.queue.filter((q) => q !== job.id);
        this.finish(job, 'cancelled');
      }
    }
    this.voices = this.voices.filter((p) => p.id !== id);
    this.emitVoices();
  }

  async addVariant(voiceId: string, input: { name: string; emotion: string | null; file: FileRef; transcript: string }) {
    await sleep(500);
    const v = this.voices.find((p) => p.id === voiceId);
    if (!v) throw new EngineError('NOT_FOUND', voiceId);
    if (!v.capabilities.includes('tts')) throw new EngineError('BAD_REQUEST', 'biến thể chỉ dùng cho giọng Đọc văn bản');
    if (v.variants.some((x) => x.name.toLowerCase() === input.name.trim().toLowerCase())) {
      throw new EngineError('BAD_REQUEST', `đã có biến thể “${input.name.trim()}”`);
    }
    const variant = { id: uid('v'), name: input.name.trim(), emotion: input.emotion, createdAt: new Date().toISOString() };
    v.variants = [...v.variants, variant];
    this.refAudio.set(`${voiceId}:${variant.id}`, input.file);
    this.emitVoices();
    return { ...v };
  }

  async deleteVariant(voiceId: string, variantId: string) {
    const v = this.voices.find((p) => p.id === voiceId);
    if (v) v.variants = v.variants.filter((x) => x.id !== variantId);
    this.emitVoices();
  }

  async previewVoice(id: string, variantId?: string): Promise<PlaySource> {
    const ref = this.refAudio.get(variantId ? `${id}:${variantId}` : id);
    if (ref?.file) return { durationSec: 8, url: URL.createObjectURL(ref.file) };
    return { durationSec: 4 }; // giọng mẫu dựng sẵn của mock: không có audio
  }

  // ---------- import / export ----------
  async inspectImport(files: FileRef[]): Promise<ImportInspection> {
    await sleep(700);
    const token = uid('imp');
    const evoice = files.find((f) => /\.evoice$/i.test(f.name));
    const pth = files.find((f) => /\.pth$/i.test(f.name));
    const index = files.find((f) => /\.index$/i.test(f.name));
    let ins: ImportInspection;
    if (evoice) {
      ins = {
        token, kind: 'evoice', fileLabel: evoice.name, blocked: false,
        checks: [
          ok('format', 'EVOICE v1'), ok('checksums', '6/6 match'),
          ok('model', 'safetensors · weights only'), ok('appVersion', '≥ 0.1.0 · OK'),
        ],
        suggestedName: evoice.name.replace(/\.evoice$/i, '').replace(/[-_]+/g, ' '),
        author: 'minh.voice', language: 'vi', license: 'personal', capabilities: ['tts', 'sts'],
        createdAt: '2026-09-30', sampleRate: 40000,
      };
    } else if (pth) {
      const unsafe = /unsafe|free_voice_pack/i.test(pth.name);
      ins = unsafe
        ? {
          token, kind: 'rvc', fileLabel: pth.name, blocked: true,
          checks: [
            ok('format', 'PyTorch pickle'),
            ok('safeLoad', 'FAILED · code objects found', true),
            ok('result', 'BLOCKED', true),
          ],
          suggestedName: '', author: '', language: 'unknown', license: 'unknown', capabilities: [], sampleRate: 0, createdAt: null,
        }
        : {
          token, kind: 'rvc', fileLabel: [pth.name, index?.name].filter(Boolean).join(' + '), blocked: false,
          checks: [
            ok('format', 'RVC v2 · 40 kHz'),
            ok('safeLoad', 'weights_only · isolated process · OK'),
            ok('convert', '.pth → .safetensors'),
            index ? ok('index', 'faiss IVF512 · OK') : ok('index', 'missing · lower similarity', true),
          ],
          suggestedName: pth.name.replace(/\.pth$/i, ''), author: 'unknown', language: 'unknown', license: 'unknown',
          capabilities: ['sts'], sampleRate: 40000, createdAt: null,
        };
    } else {
      throw new EngineError('BAD_FILE');
    }
    this.imports.set(token, ins);
    return ins;
  }

  async importVoice(token: string, name: string) {
    const ins = this.imports.get(token);
    if (!ins || ins.blocked) throw new EngineError('UNSAFE_MODEL');
    await sleep(600);
    const p = mkProfile({
      id: uid('p'), name, language: ins.language, createdAt: new Date().toISOString(), capabilities: [...ins.capabilities],
      imported: true, author: ins.author, license: ins.license, hasRef: ins.capabilities.includes('tts'), sampleRate: ins.sampleRate,
    });
    this.voices.unshift(p);
    this.emitVoices();
    return { ...p };
  }

  estimateExport(_id: string, opts: { includeModel: boolean; includeRef: boolean }) {
    return (opts.includeModel ? 142.6 : 0) + (opts.includeRef ? 1.6 : 0) + 0.4;
  }

  async exportVoice(id: string, opts: ExportOptions) {
    await sleep(900);
    const v = this.voices.find((p) => p.id === id);
    const { downloads } = await platform.appPaths();
    return { path: `${downloads}/${slugify(v?.name ?? 'voice')}.evoice`, sizeMb: this.estimateExport(id, opts) };
  }

  // ---------- TTS ----------
  normalizePreview(text: string, lang: VoiceLang, dict: DictEntry[]) {
    return normalizePreview(text, lang, dict);
  }

  private assertGpuFree() {
    if (this.rt.stats.running) throw new EngineError('GPU_BUSY_REALTIME');
  }

  async startTts(req: TtsRequest) {
    this.assertGpuFree();
    const v = this.voices.find((p) => p.id === req.profileId);
    const job = this.newJob('tts', v?.name ?? 'TTS', req.profileId);
    const parts = req.parts?.length ? req.parts : [{ text: req.text, profileId: req.profileId, variantId: req.variantId ?? null }];
    for (const p of parts) {
      const pv = this.voices.find((x) => x.id === p.profileId);
      if (!pv) throw new EngineError('NOT_FOUND', `voice ${p.profileId}`);
      if (p.variantId && !pv.variants.some((x) => x.id === p.variantId)) throw new EngineError('NOT_FOUND', `biến thể ${p.variantId}`);
    }
    const isDefault = (p: (typeof parts)[number]) => p.profileId === req.profileId && (p.variantId ?? null) === (req.variantId ?? null);
    job.sentences = parts.flatMap((p) => splitSentences(p.text).map((text) => ({ text, p })))
      .map(({ text, p }, index) => ({
        index, text, status: 'queued' as const, progress: 0, durationSec: null,
        profileId: isDefault(p) ? null : p.profileId, variantId: isDefault(p) ? null : (p.variantId ?? null),
      }));
    this.ttsReq.set(job.id, { lang: v?.language === 'en' ? 'en-US' : 'vi-VN', rate: req.speed });
    this.enqueue(job);
    return job.id;
  }

  async redoSentence(jobId: string, index: number) {
    this.assertGpuFree();
    const job = this.jobs.get(jobId);
    const s = job?.sentences?.[index];
    if (!job || !s) return;
    s.status = 'redo';
    s.progress = 0;
    if (job.status === 'done' || job.status === 'cancelled') this.enqueue(job);
    else this.emitJob(job);
  }

  async exportTts(jobId: string, format: 'wav' | 'mp3' | 'flac' | 'srt') {
    await sleep(500);
    const { downloads } = await platform.appPaths();
    return `${downloads}/easyvoice-tts-${jobId.slice(-6)}.${format}`;
  }

  async ttsAudio(jobId: string, index?: number): Promise<PlaySource> {
    // Mock: đọc bằng giọng hệ thống để test luồng nghe; engine thật trả file WAV do F5-TTS sinh ra.
    const job = this.jobs.get(jobId);
    const req = this.ttsReq.get(jobId) ?? { lang: 'vi-VN', rate: 1 };
    const done = (job?.sentences ?? []).filter((s) => s.status === 'done' && (index === undefined || s.index === index));
    return {
      durationSec: done.reduce((a, s) => a + (s.durationSec ?? 1), 0),
      speak: { texts: done.map((s) => s.text), lang: req.lang, rate: req.rate },
    };
  }

  // ---------- STS ----------
  async startSts(req: StsRequest) {
    this.assertGpuFree();
    const job = this.newJob('sts', req.file.name, req.profileId);
    this.stsStages.set(job.id, req.separate ? ['demux', 'separate', 'convert', 'remix'] : ['demux', 'prep', 'convert', 'join']);
    this.stsIn.set(job.id, { file: req.file, pitch: req.pitch });
    this.enqueue(job);
    return job.id;
  }

  /** "Đổi giọng" giả lập để có audio thật mà nghe: chỉ dịch cao độ (kéo theo tốc độ) + lọc nhẹ. Không phải RVC. */
  private async renderStsMock(jobId: string) {
    const input = this.stsIn.get(jobId);
    if (!input?.file.file || this.stsOut.has(jobId)) return;
    try {
      const ctx = new AudioContext();
      const src = await ctx.decodeAudioData(await input.file.file.arrayBuffer());
      void ctx.close();
      const rate = Math.pow(2, input.pitch / 12);
      const off = new OfflineAudioContext(Math.min(2, src.numberOfChannels), Math.ceil(src.length / rate), src.sampleRate);
      const node = off.createBufferSource();
      node.buffer = src;
      node.playbackRate.value = rate;
      const shelf = off.createBiquadFilter();
      shelf.type = 'peaking';
      shelf.frequency.value = 2500;
      shelf.gain.value = 4;
      node.connect(shelf).connect(off.destination);
      node.start();
      const out = await off.startRendering();
      const blob = encodeWav(out);
      this.stsOut.set(jobId, { blob, url: URL.createObjectURL(blob), durationSec: out.duration });
    } catch {
      /* file không giải mã được trong trình duyệt (vd. video) — engine thật dùng FFmpeg */
    }
  }

  async stsAudio(jobId: string, which: 'a' | 'b'): Promise<PlaySource> {
    const input = this.stsIn.get(jobId);
    if (which === 'a' && input?.file.file) return { durationSec: 30, url: URL.createObjectURL(input.file.file) };
    const out = this.stsOut.get(jobId);
    if (which === 'b' && out) return { durationSec: out.durationSec, url: out.url };
    return { durationSec: 30 };
  }

  async exportSts(jobId: string) {
    const job = this.jobs.get(jobId);
    const name = job?.files.output ?? 'converted.wav';
    const out = this.stsOut.get(jobId);
    if (out) downloadBlob(out.blob, name); // mock: tải file WAV thật xuống
    const { downloads } = await platform.appPaths();
    return `${downloads}/${name}`;
  }

  // ---------- Edit Audio (mock: dựng timeline, nhập file, phát trong app; xử lý AI / xuất file cần engine thật) ----------
  private editProjects = new Map<string, EditProject>();
  private editUrls = new Map<string, string>();

  private editGet(id: string): EditProject {
    const p = this.editProjects.get(id);
    if (!p) throw new EngineError('NOT_FOUND', id);
    return p;
  }

  async listEditProjects(): Promise<EditProjectSummary[]> {
    return [...this.editProjects.values()]
      .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, tracks: p.tracks.length,
        durationSec: Math.max(0, ...p.clips.map((c) => c.start + c.duration)) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createEditProject(name: string) {
    const now = Date.now() / 1000;
    const p: EditProject = { id: uid('e'), name: name || 'Dự án mới', tracks: [], clips: [], speakers: [], ripple: 'all',
      sampleRate: 48000, createdAt: now, updatedAt: now, assets: [] };
    this.editProjects.set(p.id, p);
    return structuredClone(p);
  }

  async getEditProject(id: string) {
    return structuredClone(this.editGet(id));
  }

  async saveEditProject(id: string, timeline: EditTimeline) {
    const p = this.editGet(id);
    Object.assign(p, structuredClone(timeline), { updatedAt: Date.now() / 1000 });
    return structuredClone(p);
  }

  async deleteEditProject(id: string) {
    this.editProjects.delete(id);
  }

  async editAssets(id: string) {
    return structuredClone(this.editGet(id).assets);
  }

  async addEditAssets(id: string, files: FileRef[], source: 'import' | 'record') {
    const p = this.editGet(id);
    const out: EditAsset[] = [];
    for (const ref of files) {
      if (!ref.file) throw new EngineError('BAD_FILE', ref.name);
      const meta = await decodeDuration(ref);
      if (!meta) throw new EngineError('BAD_FILE', ref.name);
      const a: EditAsset = { id: uid('a'), name: ref.name.replace(/\.[^.]+$/, ''), durationSec: meta.durationSec, sampleRate: meta.sampleRate,
        source, language: null, words: null, turns: null, createdAt: Date.now() / 1000 };
      this.editUrls.set(a.id, URL.createObjectURL(ref.file));
      p.assets.push(a);
      out.push(a);
    }
    return structuredClone(out);
  }

  editAssetUrl(_projectId: string, assetId: string) {
    return this.editUrls.get(assetId) ?? '';
  }

  async editFromJob(_jobId: string): Promise<EditProject> {
    throw new EngineError('NOT_IMPLEMENTED', 'mock engine');
  }

  async editOp(_projectId: string, _op: EditOp): Promise<string> {
    throw new EngineError('NOT_IMPLEMENTED', 'mock engine');
  }

  async downloadFile(_fileId: string) {
    throw new EngineError('NOT_IMPLEMENTED', 'mock engine');
  }

  // ---------- jobs control ----------
  async cancelJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.queue = this.queue.filter((q) => q !== id);
    if (job.kind === 'train') {
      if (job.epoch) job.log.push(`Paused · checkpoint kept at epoch ${job.epoch}`);
      else job.log.push('Paused');
      this.finish(job, 'paused');
    } else {
      this.finish(job, 'cancelled');
    }
  }

  async resumeJob(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'paused') return;
    job.log.push(job.epoch ? `Resuming from checkpoint · epoch ${job.epoch}` : 'Resuming');
    this.enqueue(job);
  }

  // ---------- real-time ----------
  async audioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
    const mac = osName() === 'mac';
    return {
      inputs: [
        { id: 'in-usb', name: 'USB Podcast Mic', virtual: false },
        { id: 'in-builtin', name: mac ? 'MacBook Pro Microphone' : 'Built-in Microphone', virtual: false },
      ],
      outputs: [
        { id: 'out-spk', name: mac ? 'MacBook Pro Speakers' : 'Speakers (Realtek)', virtual: false },
        mac
          ? { id: 'out-bh', name: 'BlackHole 2ch', virtual: true }
          : { id: 'out-cable', name: 'CABLE Input (VB-Audio)', virtual: true },
      ],
    };
  }

  async startRealtime(cfg: RealtimeConfig) {
    const v = this.voices.find((p) => p.id === cfg.profileId);
    if (!v || !v.capabilities.includes('sts') || v.trainJobId) throw new EngineError('NO_STS_VOICE');
    const cur = this.running();
    if (cur) throw new EngineError('GPU_BUSY_JOB', cur.label);
    await sleep(300);
    this.rt.cfg = { ...cfg };
    this.rt.stats = { running: true, inDb: -120, outDb: -120, latencyMs: 0, underrun: false, underruns: 0 };
    this.schedule();
  }

  async updateRealtime(patch: Partial<Pick<RealtimeConfig, 'pitch' | 'gateDb' | 'profileId'>>) {
    if (patch.profileId) {
      const v = this.voices.find((p) => p.id === patch.profileId);
      if (!v || !v.capabilities.includes('sts') || v.trainJobId) throw new EngineError('NO_STS_VOICE');
    }
    if (this.rt.cfg) this.rt.cfg = { ...this.rt.cfg, ...patch };
  }

  async setRealtimeRecording(on: boolean): Promise<Recording | null> {
    this.rt.stats = { ...this.rt.stats, recording: on, recordSec: 0 };
    return null;
  }

  async listRecordings(): Promise<Recording[]> {
    return [];
  }

  async deleteRecording(_id: string) {}

  recordingAudio(_id: string): PlaySource {
    return { durationSec: 0 };
  }

  async editFromFile(_fileId: string): Promise<EditProject> {
    throw new EngineError('NOT_IMPLEMENTED', 'mock engine');
  }

  async stopRealtime(): Promise<Recording | null> {
    this.rt.cfg = null;
    this.rt.stats = { running: false, inDb: -120, outDb: -120, latencyMs: 0, underrun: false, underruns: 0 };
    this.emit({ type: 'realtime', stats: { ...this.rt.stats } });
    this.schedule();
    return null;
  }
}
