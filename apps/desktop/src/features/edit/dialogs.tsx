// Hộp thoại của Edit Audio. Thao tác xử lý đoạn chọn chạy thành job → có bản nghe thử A (gốc) / B (đã xử lý)
// trước khi bấm Áp dụng; áp dụng xong vẫn hoàn tác được (Ctrl+Z).
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { EditFilter, EditOpResult, EditTimeline, FileRef } from '../../api/types';
import { Alert, Btn, Check, Label, Modal, OptionList, Progress, Range, Segmented } from '../../components/ui';
import { Recorder } from '../voices/Recorder';
import { editAudio } from '../../lib/editPlayer';
import {
  clipEnd, exportTimeline, formatTime, makeClip, replaceRange, replaceSegments, segmentsInRange, timelineWords,
  type ExportScope,
} from '../../lib/editTimeline';
import { MEDIA_FILTER, platform } from '../../lib/platform';
import { useEdit, type Selection } from '../../stores/edit';
import { canSts, canTts, useEngine } from '../../stores/engine';
import { useUi } from '../../stores/ui';

// ---------------------------------------------------------------- dùng chung
/** Theo dõi một job: trạng thái + tiến độ để hiển thị trong hộp thoại. */
function useJob(jobId: string | null) {
  const job = useEngine((s) => (jobId ? s.jobs[jobId] : undefined));
  return { job, running: !!job && (job.status === 'queued' || job.status === 'running') };
}

function JobLine({ jobId }: { jobId: string | null }) {
  const { t } = useTranslation();
  const { job, running } = useJob(jobId);
  if (!job || !running) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between font-mono text-[11px] text-mute">
        <span>{job.status === 'queued' && job.waitingFor ? t('training.waitingFor', { name: job.waitingFor }) : t('common.working')}</span>
        <span>{Math.round(job.progress * 100)}%</span>
      </div>
      <Progress value={job.progress} />
    </div>
  );
}

/** Timeline chỉ còn một track (bỏ tắt tiếng/solo) để nghe riêng đoạn đang sửa. */
function soloTrack(t: EditTimeline, trackId: string): EditTimeline {
  return { ...t, tracks: t.tracks.filter((x) => x.id === trackId).map((x) => ({ ...x, mute: false, solo: false })),
    clips: t.clips.filter((c) => c.trackId === trackId) };
}

function useAB() {
  const [playing, setPlaying] = useState<'a' | 'b' | null>(null);
  useEffect(() => () => { editAudio.stop(); }, []);
  const play = (which: 'a' | 'b', t: EditTimeline, from: number, to: number) => {
    useEdit.getState().pause();
    if (playing === which) {
      editAudio.stop();
      return setPlaying(null);
    }
    editAudio.play(t, Math.max(0, from), () => setPlaying(null), to);
    setPlaying(which);
  };
  return { playing, play };
}

function ABButtons({ ab, a, b, disabledB }: { ab: ReturnType<typeof useAB>; a: () => void; b: () => void; disabledB?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 border border-line">
      <button type="button" onClick={a} className={`border-0 border-r border-line px-3 py-2.5 cursor-pointer font-mono text-[12px] font-bold ${ab.playing === 'a' ? 'bg-fg text-bg' : 'bg-transparent text-fg'}`}>
        {ab.playing === 'a' ? '■' : '▶'} A · {t('edit.ab.original')}
      </button>
      <button type="button" onClick={b} disabled={disabledB} className={`border-0 px-3 py-2.5 cursor-pointer font-mono text-[12px] font-bold ${ab.playing === 'b' ? 'bg-acc text-bg' : 'bg-transparent text-acc'}`}>
        {ab.playing === 'b' ? '■' : '▶'} B · {t('edit.ab.processed')}
      </button>
    </div>
  );
}

const selText = (sel: Selection) => `${formatTime(sel.start)} – ${formatTime(sel.end)} · ${(sel.end - sel.start).toFixed(2)}s`;

// ---------------------------------------------------------------- lọc âm
const FILTER_DEFS: { id: EditFilter; amount?: { min: number; max: number; step: number; def: number; unit: string } }[] = [
  { id: 'denoise', amount: { min: 0.1, max: 1, step: 0.05, def: 0.6, unit: '%' } },
  { id: 'eq_voice' },
  { id: 'highpass', amount: { min: 40, max: 400, step: 10, def: 90, unit: 'Hz' } },
  { id: 'compress', amount: { min: -40, max: -10, step: 1, def: -24, unit: 'dB' } },
  { id: 'loudness', amount: { min: -30, max: -10, step: 1, def: -16, unit: 'LUFS' } },
  { id: 'normalize', amount: { min: -6, max: 0, step: 0.5, def: -1, unit: 'dBFS' } },
  { id: 'eq_warm' },
  { id: 'eq_bright' },
  { id: 'telephone' },
];

export function FilterDialog({ sel, onClose }: { sel: Selection; onClose: () => void }) {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const [filter, setFilter] = useState<EditFilter>('denoise');
  const def = FILTER_DEFS.find((f) => f.id === filter)!;
  const [amount, setAmount] = useState<number | null>(def.amount?.def ?? null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; assets: string[] } | null>(null);
  const { running } = useJob(jobId);
  const ab = useAB();
  const segs = useMemo(() => segmentsInRange(timeline, sel.trackId, sel.start, sel.end), [timeline, sel]);
  const key = `${filter}:${amount}`;
  const fresh = result?.key === key;

  const pick = (id: EditFilter) => {
    setFilter(id);
    setAmount(FILTER_DEFS.find((f) => f.id === id)!.amount?.def ?? null);
  };
  const process = async () => {
    const id = await useEdit.getState().runOp(
      { op: 'filter', segments: segs.map((s) => ({ assetId: s.assetId, offset: s.offset, duration: s.duration })), filter, amount },
      t(`edit.filter.${filter}.name`),
      (res) => { if (res.assets) setResult({ key, assets: res.assets }); },
    );
    setJobId(id);
  };
  const processed = () => result && replaceSegments(soloTrack(timeline, sel.trackId), sel.trackId, segs, result.assets);
  const apply = () => {
    if (!result) return;
    useEdit.getState().commit((x) => replaceSegments(x, sel.trackId, segs, result.assets));
    onClose();
  };
  const fmt = (v: number) => (def.amount?.unit === '%' ? `${Math.round(v * 100)}%` : `${v} ${def.amount?.unit}`);

  return (
    <Modal title={t('edit.filter.title')} onClose={onClose} width={600} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        {!fresh ? <Btn variant="inverse" onClick={() => void process()} disabled={running || !segs.length}>{running ? t('common.working') : `▶ ${t('edit.preview')}`}</Btn>
          : <Btn variant="primary" onClick={apply}>{t('edit.apply')}</Btn>}
      </>
    }>
      <span className="font-mono text-[11px] text-mute">{selText(sel)}</span>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] border border-line">
        {FILTER_DEFS.map((f) => (
          <button key={f.id} type="button" onClick={() => pick(f.id)} aria-pressed={filter === f.id}
            className={`text-left border-0 border-b border-r border-line2 px-3 py-2.5 cursor-pointer min-h-[56px] ${filter === f.id ? 'bg-fg text-bg' : 'bg-transparent text-fg'}`}>
            <span className="block font-semibold text-[13px]">{t(`edit.filter.${f.id}.name`)}</span>
            <span className="block text-[11px] opacity-75">{t(`edit.filter.${f.id}.desc`)}</span>
          </button>
        ))}
      </div>
      {def.amount && amount !== null && (
        <Range label={t('edit.filter.amount')} valueText={fmt(amount)} min={def.amount.min} max={def.amount.max} step={def.amount.step}
          value={amount} onChange={setAmount} />
      )}
      <JobLine jobId={jobId} />
      <ABButtons ab={ab} disabledB={!fresh}
        a={() => ab.play('a', soloTrack(timeline, sel.trackId), sel.start, sel.end)}
        b={() => { const p = processed(); if (p) ab.play('b', p, sel.start, sel.end); }} />
      <span className="text-[12px] text-mute">{t('edit.filter.hint')}</span>
    </Modal>
  );
}

// ---------------------------------------------------------------- sửa lời bằng văn bản
export function RetextDialog({ sel, onClose }: { sel: Selection; onClose: () => void }) {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const assets = useEdit((s) => s.assets);
  const segs = useMemo(() => segmentsInRange(timeline, sel.trackId, sel.start, sel.end), [timeline, sel]);
  const seg = segs.length === 1 ? segs[0] : null;
  const clip = seg ? timeline.clips.find((c) => c.id === seg.clipId) : undefined;
  const original = useMemo(() => timelineWords(timeline, assets, sel.trackId)
    .filter((w) => (w.start + w.end) / 2 >= sel.start && (w.start + w.end) / 2 < sel.end).map((w) => w.text).join(' '), [timeline, assets, sel]);
  const [text, setText] = useState(original);
  const otherTracks = timeline.tracks.length > 1;
  const [keep, setKeep] = useState(otherTracks);
  const [seed, setSeed] = useState(1234);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<{ asset: string; repOffset: number; repDuration: number; key: string } | null>(null);
  const { running } = useJob(jobId);
  const ab = useAB();
  const key = `${text}|${keep}|${seed}`;
  const fresh = result?.key === key;
  const tooLong = sel.end - sel.start > 15;

  const process = async (s = seed) => {
    if (!seg) return;
    const key = `${text}|${keep}|${s}`;
    const id = await useEdit.getState().runOp(
      { op: 'retext', assetId: seg.assetId, offset: seg.offset, duration: seg.duration, text, keepDuration: keep, language: 'auto', seed: s },
      t('edit.retext.title'),
      (res: EditOpResult) => {
        if (res.assets?.[0]) setResult({ asset: res.assets[0], repOffset: res.replaceOffset ?? seg.offset, repDuration: res.replaceDuration ?? seg.duration, key });
      },
    );
    setJobId(id);
  };

  /** Áp bản sửa vào một timeline: đổi khoảng thay thế từ thời gian asset sang timeline, cắt phần tràn khỏi clip. */
  const applyTo = (x: EditTimeline) => {
    const a = result && assets[result.asset];
    if (!result || !a || !clip) return null;
    let s = clip.start + (result.repOffset - clip.offset);
    let e = s + result.repDuration;
    const front = Math.max(0, clip.start - s);
    const back = Math.max(0, e - clipEnd(clip));
    s += front;
    e -= back;
    return { timeline: replaceRange(x, sel.trackId, s, e, { assetId: a.id, offset: front, duration: a.durationSec - front - back,
      gainDb: clip.gainDb, fadeIn: 0, fadeOut: 0, label: null, speaker: clip.speaker }), s, len: a.durationSec - front - back };
  };
  const apply = () => {
    if (!applyTo(timeline)) return;
    useEdit.getState().commit((x) => applyTo(x)?.timeline ?? x);
    onClose();
  };

  return (
    <Modal title={t('edit.retext.title')} onClose={onClose} width={600} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        {fresh && <Btn variant="ghost" disabled={running} onClick={() => { setSeed(seed + 1); void process(seed + 1); }}>↻ {t('edit.retext.again')}</Btn>}
        {!fresh ? <Btn variant="inverse" onClick={() => void process()} disabled={running || !seg || !text.trim() || tooLong}>{running ? t('common.working') : `▶ ${t('edit.retext.generate')}`}</Btn>
          : <Btn variant="primary" onClick={apply}>{t('edit.apply')}</Btn>}
      </>
    }>
      <span className="font-mono text-[11px] text-mute">{selText(sel)}</span>
      {!seg && <Alert title={t('edit.retext.oneClip')} />}
      {tooLong && <Alert title={t('edit.retext.tooLong')} />}
      <div className="flex flex-col gap-1.5">
        <Label>{t('edit.retext.original')}</Label>
        <div className="border border-line px-3 py-2 text-soft min-h-[40px]">{original || <span className="text-mute">{t('edit.retext.noWords')}</span>}</div>
      </div>
      <label className="flex flex-col gap-1.5">
        <Label>{t('edit.retext.newText')}</Label>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus
          className="bg-bg border border-line3 p-3 text-fg text-[15px] resize-y rounded-none" />
      </label>
      <Check id="retext-keep" checked={keep} onChange={setKeep} sub={t('edit.retext.keepHint')}>{t('edit.retext.keep')}</Check>
      <JobLine jobId={jobId} />
      <ABButtons ab={ab} disabledB={!fresh}
        a={() => ab.play('a', soloTrack(timeline, sel.trackId), sel.start - 1.5, sel.end + 1.5)}
        b={() => {
          const r = applyTo(soloTrack(timeline, sel.trackId));
          if (r) ab.play('b', r.timeline, r.s - 1.5, r.s + r.len + 1.5);
        }} />
      <span className="text-[12px] text-mute">{t('edit.retext.hint')}</span>
    </Modal>
  );
}

// ---------------------------------------------------------------- đọc bằng giọng đã lưu / đổi giọng RVC
export function SpeakDialog({ sel, onClose }: { sel: Selection | null; onClose: () => void }) {
  const { t } = useTranslation();
  const voices = useEngine((s) => s.voices).filter(canTts);
  const timeline = useEdit((s) => s.timeline)!;
  const trackId = useEdit((s) => s.trackId);
  const playhead = useEdit((s) => s.playhead);
  const assets = useEdit((s) => s.assets);
  const [voice, setVoice] = useState(voices[0]?.id ?? '');
  const [variant, setVariant] = useState('');
  const [text, setText] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [asset, setAsset] = useState<{ id: string; key: string } | null>(null);
  const { running } = useJob(jobId);
  const ab = useAB();
  const v = voices.find((x) => x.id === voice);
  const key = `${voice}|${variant}|${text}`;
  const fresh = asset?.key === key;
  const target = sel?.trackId ?? trackId ?? timeline.tracks[0]?.id;
  const s = sel?.start ?? playhead;
  const e = sel?.end ?? playhead;

  const process = async () => {
    const id = await useEdit.getState().runOp({ op: 'speak', profileId: voice, variantId: variant || null, text, speed: 1, seed: 1234 },
      t('edit.speak.title'), (res) => { if (res.assets?.[0]) setAsset({ id: res.assets[0], key }); });
    setJobId(id);
  };
  const applyTo = (x: EditTimeline) => {
    const a = asset && assets[asset.id];
    if (!a || !target) return x;
    return replaceRange(x, target, s, e, { assetId: a.id, offset: 0, duration: a.durationSec, gainDb: 0, fadeIn: 0.01, fadeOut: 0.01, label: v?.name ?? null, speaker: null });
  };
  return (
    <Modal title={t('edit.speak.title')} onClose={onClose} width={560} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        {!fresh ? <Btn variant="inverse" onClick={() => void process()} disabled={running || !voice || !text.trim()}>{running ? t('common.working') : `▶ ${t('edit.retext.generate')}`}</Btn>
          : <Btn variant="primary" disabled={!target} onClick={() => { useEdit.getState().commit(applyTo); onClose(); }}>{sel ? t('edit.speak.replace') : t('edit.speak.insert')}</Btn>}
      </>
    }>
      <span className="font-mono text-[11px] text-mute">{sel ? selText(sel) : `${t('edit.speak.at')} ${formatTime(playhead)}`}</span>
      {voices.length ? (
        <OptionList value={voice} onChange={(id) => { setVoice(id); setVariant(''); }} options={voices.map((x) => ({ id: x.id, name: x.name, tag: x.language.toUpperCase() }))} />
      ) : <Alert title={t('edit.speak.noVoice')} />}
      {!!v?.variants.length && (
        <Segmented value={variant} onChange={setVariant} options={[{ id: '', label: t('edit.speak.standard') }, ...v.variants.map((x) => ({ id: x.id, label: x.name }))]} />
      )}
      <label className="flex flex-col gap-1.5">
        <Label>{t('edit.speak.text')}</Label>
        <textarea value={text} onChange={(ev) => setText(ev.target.value)} rows={3} className="bg-bg border border-line3 p-3 text-fg text-[15px] resize-y rounded-none" />
      </label>
      <JobLine jobId={jobId} />
      {fresh && asset && (
        <ABButtons ab={ab} a={() => target && ab.play('a', soloTrack(timeline, target), s - 1, e + 1)}
          b={() => {
            const a = assets[asset.id];
            if (target && a) ab.play('b', applyTo(soloTrack(timeline, target)), s - 1, s + a.durationSec + 1);
          }} />
      )}
    </Modal>
  );
}

export function ConvertDialog({ sel, onClose }: { sel: Selection; onClose: () => void }) {
  const { t } = useTranslation();
  const voices = useEngine((s) => s.voices).filter(canSts);
  const timeline = useEdit((s) => s.timeline)!;
  const [voice, setVoice] = useState(voices[0]?.id ?? '');
  const [pitch, setPitch] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; assets: string[] } | null>(null);
  const { running } = useJob(jobId);
  const ab = useAB();
  const segs = useMemo(() => segmentsInRange(timeline, sel.trackId, sel.start, sel.end), [timeline, sel]);
  const key = `${voice}|${pitch}`;
  const fresh = result?.key === key;
  const process = async () => {
    const id = await useEdit.getState().runOp(
      { op: 'convert', segments: segs.map((s) => ({ assetId: s.assetId, offset: s.offset, duration: s.duration })), profileId: voice, pitch },
      t('edit.convert.title'), (res) => { if (res.assets) setResult({ key, assets: res.assets }); });
    setJobId(id);
  };
  return (
    <Modal title={t('edit.convert.title')} onClose={onClose} width={520} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        {!fresh ? <Btn variant="inverse" onClick={() => void process()} disabled={running || !voice || !segs.length}>{running ? t('common.working') : `▶ ${t('edit.preview')}`}</Btn>
          : <Btn variant="primary" onClick={() => { useEdit.getState().commit((x) => replaceSegments(x, sel.trackId, segs, result!.assets)); onClose(); }}>{t('edit.apply')}</Btn>}
      </>
    }>
      <span className="font-mono text-[11px] text-mute">{selText(sel)}</span>
      {voices.length ? <OptionList value={voice} onChange={setVoice} options={voices.map((x) => ({ id: x.id, name: x.name }))} />
        : <Alert title={t('errors.NO_STS_VOICE')} />}
      <Range label={t('sts.pitch')} valueText={`${pitch > 0 ? '+' : ''}${pitch} st`} min={-12} max={12} step={1} value={pitch} onChange={setPitch} hint={t('sts.pitchHint')} />
      <JobLine jobId={jobId} />
      <ABButtons ab={ab} disabledB={!fresh}
        a={() => ab.play('a', soloTrack(timeline, sel.trackId), sel.start, sel.end)}
        b={() => result && ab.play('b', replaceSegments(soloTrack(timeline, sel.trackId), sel.trackId, segs, result.assets), sel.start, sel.end)} />
    </Modal>
  );
}

// ---------------------------------------------------------------- thay bằng file / thu âm
export function ReplaceDialog({ sel, onClose }: { sel: Selection; onClose: () => void }) {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const [recording, setRecording] = useState(false);
  const [match, setMatch] = useState(true);
  const [busy, setBusy] = useState(false);
  const use = async (files: FileRef[], source: 'import' | 'record') => {
    setBusy(true);
    try {
      const [a] = await useEdit.getState().importFiles(files, source, false);
      if (!a) return;
      const pid = useEdit.getState().projectId!;
      await editAudio.load(a.id, engine().editAssetUrl(pid, a.id));
      let gainDb = 0;
      if (match) { // khớp âm lượng với đoạn bị thay (RMS)
        const segs = segmentsInRange(timeline, sel.trackId, sel.start, sel.end);
        const total = segs.reduce((m, s) => m + s.duration, 0);
        const orig = total ? Math.sqrt(segs.reduce((m, s) => m + editAudio.rms(s.assetId, s.offset, s.duration) ** 2 * s.duration, 0) / total) : 0;
        const neu = editAudio.rms(a.id, 0, a.durationSec);
        if (orig > 1e-4 && neu > 1e-4) gainDb = Math.max(-18, Math.min(18, 20 * Math.log10(orig / neu)));
      }
      useEdit.getState().commit((x) => replaceRange(x, sel.trackId, sel.start, sel.end,
        { assetId: a.id, offset: 0, duration: a.durationSec, gainDb: Math.round(gainDb * 10) / 10, fadeIn: 0.015, fadeOut: 0.015, label: a.name, speaker: null }));
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    const files = await platform.pickFiles({ title: t('edit.replace.choose'), filters: [MEDIA_FILTER] });
    if (files[0]) await use([files[0]], 'import');
  };
  return (
    <Modal title={t('edit.replace.title')} onClose={onClose} width={480} footer={<Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>}>
      <span className="font-mono text-[11px] text-mute">{selText(sel)}</span>
      <p className="m-0 text-soft">{t('edit.replace.body')}</p>
      <Check id="replace-match" checked={match} onChange={setMatch} sub={t('edit.replace.matchHint')}>{t('edit.replace.match')}</Check>
      <div className="flex gap-2 flex-wrap">
        <Btn variant="outline" disabled={busy} onClick={() => void pick()}>{t('edit.replace.choose')}</Btn>
        <Btn variant="ghost" disabled={busy} onClick={() => setRecording(true)}>● {t('edit.record')}</Btn>
      </div>
      {busy && <span className="font-mono text-[11px] text-mute">{t('common.working')}</span>}
      {recording && <Recorder maxSec={600} minSec={0.3} onClose={() => setRecording(false)}
        onDone={(ref) => { setRecording(false); void use([ref], 'record'); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- dọn khoảng lặng
export function SilencesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const trackId = useEdit((s) => s.trackId);
  const p0 = useEdit((s) => s.silenceParams);
  const [scope, setScope] = useState<'track' | 'all'>(trackId ? p0.scope : 'all');
  const [threshold, setThreshold] = useState(p0.thresholdDb);
  const [minSec, setMinSec] = useState(p0.minSec);
  const [padBefore, setPadBefore] = useState(p0.padBefore);
  const [padAfter, setPadAfter] = useState(p0.padAfter);
  const [jobId, setJobId] = useState<string | null>(null);
  const [none, setNone] = useState(false);
  const { running } = useJob(jobId);
  const find = async () => {
    setNone(false);
    const ed = useEdit.getState();
    const target = scope === 'track' && trackId ? trackId : null;
    useEdit.setState({ silenceParams: { scope, thresholdDb: threshold, minSec, padBefore, padAfter }, silenceReview: null });
    const id = await ed.runOp({ op: 'silences', timeline, trackIds: target ? [target] : null, thresholdDb: threshold, minSec, padBefore, padAfter },
      t('edit.silences.title'), (res) => {
        const ranges = res.ranges ?? [];
        if (!ranges.length) return setNone(true);
        // Xem các điểm đánh dấu trên timeline trước khi cắt (thanh xác nhận phía trên timeline)
        useEdit.getState().setSilenceReview({ ranges, skip: ranges.map(() => false), trackId: target });
        onClose();
      });
    setJobId(id);
  };
  const sec = (v: number) => `${v.toFixed(2)} s`;
  return (
    <Modal title={t('edit.silences.title')} onClose={onClose} width={520} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn variant="primary" onClick={() => void find()} disabled={running}>{running ? t('common.working') : t('edit.silences.find')}</Btn>
      </>
    }>
      <p className="m-0 text-soft">{t('edit.silences.body')}</p>
      {trackId && <Segmented value={scope} onChange={setScope} options={[{ id: 'track', label: t('edit.silences.thisTrack') }, { id: 'all', label: t('edit.silences.allTracks') }]} />}
      <Range label={t('edit.silences.threshold')} valueText={`${threshold} dB`} min={-65} max={-10} step={1} value={threshold} onChange={setThreshold}
        hint={t('edit.silences.thresholdHint')} />
      <Range label={t('edit.silences.min')} valueText={`${minSec.toFixed(1)} s`} min={0.1} max={3} step={0.1} value={minSec} onChange={setMinSec} />
      <div className="grid grid-cols-2 gap-4">
        <Range label={t('edit.silences.padBefore')} valueText={sec(padBefore)} min={0} max={1} step={0.01} value={padBefore} onChange={setPadBefore} />
        <Range label={t('edit.silences.padAfter')} valueText={sec(padAfter)} min={0} max={1} step={0.01} value={padAfter} onChange={setPadAfter} />
      </div>
      <span className="text-[12px] text-mute">{t('edit.silences.padHint')}</span>
      {padBefore + padAfter >= minSec && <span className="text-[12px] text-acc">{t('edit.silences.padTooLong')}</span>}
      <JobLine jobId={jobId} />
      {none && <Alert tone="line" title={t('edit.silences.none')} />}
      {timeline.ripple !== 'all' && <span className="text-[12px] text-mute">{t('edit.silences.rippleHint')}</span>}
    </Modal>
  );
}

// ---------------------------------------------------------------- hạ nhạc nền theo giọng
export function DuckDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const [music, setMusic] = useState<string[]>(timeline.tracks.filter((x) => x.kind === 'music').map((x) => x.id));
  const [amount, setAmount] = useState(-12);
  const [jobId, setJobId] = useState<string | null>(null);
  const { running } = useJob(jobId);
  const voice = timeline.tracks.filter((x) => !music.includes(x.id)).map((x) => x.id);
  const run = async () => {
    const id = await useEdit.getState().runOp({ op: 'duck', timeline, musicTrackIds: music, voiceTrackIds: voice, amountDb: amount },
      t('edit.duck.title'), (res) => {
        const map = res.tracks ?? {};
        useEdit.getState().commit((x) => {
          let out = x;
          for (const [tid, aid] of Object.entries(map)) {
            const a = useEdit.getState().assets[aid];
            if (!a) continue;
            out = { ...out, clips: [...out.clips.filter((c) => c.trackId !== tid), makeClip({ trackId: tid, assetId: aid, start: 0, duration: a.durationSec, label: a.name })] };
          }
          return out;
        });
        onClose();
      });
    setJobId(id);
  };
  return (
    <Modal title={t('edit.duck.title')} onClose={onClose} width={520} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn variant="primary" onClick={() => void run()} disabled={running || !music.length || !voice.length}>{running ? t('common.working') : t('edit.apply')}</Btn>
      </>
    }>
      <p className="m-0 text-soft">{t('edit.duck.body')}</p>
      <Label>{t('edit.duck.music')}</Label>
      <div className="flex flex-col gap-2">
        {timeline.tracks.map((tr) => (
          <Check key={tr.id} id={`duck-${tr.id}`} checked={music.includes(tr.id)}
            onChange={(on) => setMusic(on ? [...music, tr.id] : music.filter((x) => x !== tr.id))}>{tr.name}</Check>
        ))}
      </div>
      <Range label={t('edit.duck.amount')} valueText={`${amount} dB`} min={-30} max={-3} step={1} value={amount} onChange={setAmount} />
      <JobLine jobId={jobId} />
    </Modal>
  );
}

// ---------------------------------------------------------------- xuất file
const LOUDNESS: { id: string; lufs: number | null }[] = [
  { id: 'none', lufs: null }, { id: 'youtube', lufs: -14 }, { id: 'podcast', lufs: -16 }, { id: 'broadcast', lufs: -23 },
];

export function ExportDialog({ onClose, scope = { kind: 'all' } }: { onClose: () => void; scope?: ExportScope }) {
  const { t } = useTranslation();
  const full = useEdit((s) => s.timeline)!;
  const timeline = useMemo(() => exportTimeline(full, scope), [full, scope]);
  const assets = useEdit((s) => s.assets);
  const toast = useUi((s) => s.toast);
  const [format, setFormat] = useState<'wav' | 'mp3' | 'flac'>('wav');
  const [loud, setLoud] = useState('none');
  const hasWords = useMemo(() => timelineWords(timeline, assets, null).length > 0, [timeline, assets]);
  const [srt, setSrt] = useState(hasWords);
  const [jobId, setJobId] = useState<string | null>(null);
  const [measure, setMeasure] = useState<EditOpResult | null>(null);
  const { running } = useJob(jobId);
  const lufs = LOUDNESS.find((x) => x.id === loud)!.lufs;
  const run = async (doExport: boolean) => {
    const id = await useEdit.getState().runOp({ op: 'render', timeline, format: doExport ? format : null, targetLufs: lufs, srt: doExport && srt && hasWords },
      t('edit.export.title'), async (res) => {
        setMeasure(res);
        if (!doExport || !res.file) return;
        await engine().downloadFile(res.file);
        // Trình duyệt bỏ qua lần tải thứ hai nếu bấm liền nhau: chờ một chút rồi mới tải phụ đề
        if (res.srt) setTimeout(() => void engine().downloadFile(res.srt!), 700);
        toast(t('edit.export.done'));
        onClose();
      });
    setJobId(id);
  };
  return (
    <Modal title={scope.kind === 'all' ? t('edit.export.title') : (scope.kind === 'track' ? t('edit.export.titleTrack') : t('edit.export.titleClip'))} onClose={onClose} width={520} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn variant="ghost" onClick={() => void run(false)} disabled={running}>{t('edit.export.measure')}</Btn>
        <Btn variant="primary" onClick={() => void run(true)} disabled={running || !timeline.clips.length}>{running ? t('common.working') : t('edit.export.go')}</Btn>
      </>
    }>
      {scope.kind !== 'all' && <div className="font-mono text-[12px] text-soft border border-line px-3 py-2 truncate">{timeline.name}</div>}
      <Label>{t('edit.export.format')}</Label>
      <Segmented mono value={format} onChange={setFormat} options={[{ id: 'wav', label: 'WAV' }, { id: 'mp3', label: 'MP3' }, { id: 'flac', label: 'FLAC' }]} />
      <Label>{t('edit.export.loudness')}</Label>
      <Segmented value={loud} onChange={setLoud} options={LOUDNESS.map((x) => ({ id: x.id, label: t(`edit.export.loud.${x.id}`), desc: x.lufs === null ? '—' : `${x.lufs} LUFS` }))} />
      <Check id="export-srt" checked={srt && hasWords} disabled={!hasWords} onChange={setSrt} sub={hasWords ? t('edit.export.srtHint') : t('edit.export.srtNone')}>{t('edit.export.srt')}</Check>
      <JobLine jobId={jobId} />
      {measure && measure.lufs !== undefined && (
        <div className="grid grid-cols-3 border border-line font-mono text-[12px]">
          <div className="px-3 py-2 border-r border-line"><div className="text-mute text-[10px]">LOUDNESS</div>{measure.lufs ?? '—'} LUFS</div>
          <div className="px-3 py-2 border-r border-line"><div className="text-mute text-[10px]">PEAK</div>{measure.peakDb ?? '—'} dBFS</div>
          <div className="px-3 py-2"><div className="text-mute text-[10px]">{t('edit.export.length')}</div>{formatTime(measure.durationSec ?? 0)}</div>
        </div>
      )}
      <span className="text-[12px] text-mute">{t('edit.export.hint')}</span>
    </Modal>
  );
}
