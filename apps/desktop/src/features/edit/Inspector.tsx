// Bảng thao tác bên phải: vùng chọn (sửa, lọc, AI), clip đang chọn (âm lượng, fade, người nói), track (chép lời,
// nhận diện người nói, tách nhạc), danh sách người nói (đổi tên, tách track / cắt theo người).
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { EditClip } from '../../api/types';
import { Label, Progress } from '../../components/ui';
import {
  applySeparation, clipEnd, deleteClip, deleteRange, deleteTrack, ensureSpeakers, formatTime, segmentsInRange, splitAt,
  splitBySpeakers, updateClip,
} from '../../lib/editTimeline';
import { useEdit } from '../../stores/edit';
import { useEngine } from '../../stores/engine';
import { useSeparatorReady } from '../../lib/models';

export type DialogKind = 'filter' | 'retext' | 'speak' | 'convert' | 'replace' | 'export' | 'silences' | 'duck';

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex justify-between items-center px-3.5 py-2 border-b border-line2 font-mono text-[11px] tracking-label text-mute">
        <span>{title}</span>{right}
      </div>
      <div className="px-3.5 py-3 flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

function Act({ children, onClick, disabled, title, accent }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string; accent?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={`text-left border px-2.5 py-2 min-h-[36px] cursor-pointer text-[13px] font-semibold ${accent ? 'border-acc text-acc hover:bg-acc hover:text-bg' : 'border-line3 text-fg bg-transparent hover:border-fg'}`}>
      {children}
    </button>
  );
}

function Pending() {
  const { t } = useTranslation();
  const pending = useEdit((s) => s.pending);
  const jobs = useEngine((s) => s.jobs);
  if (!pending.length) return null;
  return (
    <Section title={t('edit.running')}>
      {pending.map((p) => {
        const job = jobs[p.jobId];
        return (
          <div key={p.jobId} className="flex flex-col gap-1">
            <div className="flex justify-between gap-2 text-[12px]">
              <span className="font-semibold">{p.label}</span>
              <span className="font-mono text-mute">
                {job?.status === 'queued' && job.waitingFor ? t('training.waitingFor', { name: job.waitingFor }) : `${Math.round((job?.progress ?? 0) * 100)}%`}
              </span>
            </div>
            <Progress value={job?.progress ?? 0} />
          </div>
        );
      })}
    </Section>
  );
}

export function Inspector({ openDialog }: { openDialog: (d: DialogKind) => void }) {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const assets = useEdit((s) => s.assets);
  const selection = useEdit((s) => s.selection);
  const clipId = useEdit((s) => s.clipId);
  const trackId = useEdit((s) => s.trackId);
  const playhead = useEdit((s) => s.playhead);
  const ed = useEdit.getState;
  const sepReady = useSeparatorReady();
  const clip = timeline.clips.find((c) => c.id === clipId);
  const track = timeline.tracks.find((x) => x.id === trackId);
  const trackAssets = [...new Set(timeline.clips.filter((c) => c.trackId === trackId).map((c) => c.assetId))];
  const hasWords = trackAssets.some((id) => assets[id]?.words);
  const hasTurns = trackAssets.some((id) => assets[id]?.turns?.length);
  const segs = selection ? segmentsInRange(timeline, selection.trackId, selection.start, selection.end) : [];
  const [speakersN, setSpeakersN] = useState<number | null>(null);

  const transcribe = () => void ed().runOp({ op: 'transcribe', assetIds: trackAssets, language: 'auto' }, t('edit.track.transcribe'));
  const diarize = () => void ed().runOp({ op: 'diarize', assetIds: trackAssets, numSpeakers: speakersN }, t('edit.track.diarize'), () => {
    const ids = new Set<number>();
    for (const id of trackAssets) for (const turn of ed().assets[id]?.turns ?? []) ids.add(turn.speaker);
    ed().commit((x) => ensureSpeakers(x, ids, t('edit.speaker')));
  });
  const separate = () => void ed().runOp({ op: 'separate', assetIds: trackAssets }, t('edit.track.separate'), (res) => {
    if (!res.pairs || !trackId) return;
    ed().commit((x) => applySeparation(x, trackId, res.pairs!, { voice: t('edit.kind.voice'), music: t('edit.kind.music') }).timeline);
  });

  return (
    <div className="border border-line flex flex-col min-w-0">
      <Pending />
      {selection && (
        <Section title={t('edit.sel.title')} right={<span className="font-mono">{(selection.end - selection.start).toFixed(2)}s</span>}>
          <span className="font-mono text-[11px] text-mute">{formatTime(selection.start)} – {formatTime(selection.end)} · {timeline.tracks.find((x) => x.id === selection.trackId)?.name}</span>
          <div className="grid grid-cols-2 gap-1.5">
            <Act onClick={() => { ed().commit((x) => deleteRange(x, selection.trackId, selection.start, selection.end)); ed().setSelection(null); }}>✕ {t('edit.sel.delete')}</Act>
            <Act onClick={() => ed().commit((x) => splitAt(splitAt(x, selection.start, [selection.trackId]), selection.end, [selection.trackId]))}>⫼ {t('edit.sel.split')}</Act>
            <Act onClick={() => ed().play(selection.start, selection.end)}>▶ {t('edit.sel.play')}</Act>
            <Act onClick={() => ed().setSelection(null)}>{t('edit.sel.clear')}</Act>
          </div>
          <Label>{t('edit.sel.process')}</Label>
          <div className="grid grid-cols-2 gap-1.5">
            <Act onClick={() => openDialog('filter')} disabled={!segs.length}>{t('edit.sel.filter')}</Act>
            <Act onClick={() => openDialog('retext')} disabled={!segs.length} accent>{t('edit.sel.retext')}</Act>
            <Act onClick={() => openDialog('convert')} disabled={!segs.length}>{t('edit.sel.convert')}</Act>
            <Act onClick={() => openDialog('speak')}>{t('edit.sel.speak')}</Act>
            <Act onClick={() => openDialog('replace')}>{t('edit.sel.replace')}</Act>
          </div>
        </Section>
      )}
      {clip && !selection && <ClipPanel clip={clip} playhead={playhead} />}
      {track && (
        <Section title={`${t('edit.track.title')} · ${track.name}`}>
          <div className="grid grid-cols-2 gap-1.5">
            <Act onClick={transcribe} disabled={!trackAssets.length}>{hasWords ? '↻ ' : ''}{t('edit.track.transcribe')}</Act>
            <Act onClick={separate} disabled={!trackAssets.length || !sepReady} title={sepReady ? undefined : t('models.separatorMissing')}>{t('edit.track.separate')}</Act>
            <Act onClick={diarize} disabled={!trackAssets.length}>{t('edit.track.diarize')}</Act>
            <label className="flex items-center gap-1.5 border border-line3 px-2 text-[12px]">
              <span className="text-mute">{t('edit.track.people')}</span>
              <select value={speakersN ?? ''} onChange={(e) => setSpeakersN(e.target.value ? Number(e.target.value) : null)}
                className="bg-bg text-fg border-0 flex-1 min-w-0 py-1.5">
                <option value="">{t('edit.track.auto')}</option>
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          {!sepReady && <span className="text-[11px] text-mute">{t('models.separatorMissing')}</span>}
          <div className="grid grid-cols-2 gap-1.5">
            <Act onClick={() => openDialog('silences')}>{t('edit.track.silences')}</Act>
            <Act onClick={() => openDialog('duck')} disabled={timeline.tracks.length < 2}>{t('edit.track.duck')}</Act>
            <Act onClick={() => ed().commit((x) => splitAt(x, playhead, [track.id]))}>⫼ {t('edit.track.splitHere')}</Act>
            <Act onClick={() => { ed().commit((x) => deleteTrack(x, track.id)); ed().selectTrack(null); }}>✕ {t('edit.track.delete')}</Act>
          </div>
        </Section>
      )}
      {(hasTurns || timeline.speakers.length > 0) && <SpeakersPanel trackId={trackId} canSplit={hasTurns} />}
      {!selection && !clip && !track && <div className="px-3.5 py-4 text-[13px] text-mute">{t('edit.inspectorEmpty')}</div>}
    </div>
  );
}

function ClipPanel({ clip, playhead }: { clip: EditClip; playhead: number }) {
  const { t } = useTranslation();
  const ed = useEdit.getState;
  const speakers = useEdit((s) => s.timeline?.speakers ?? []);
  const [gain, setGain] = useState(clip.gainDb);
  const [fi, setFi] = useState(clip.fadeIn);
  const [fo, setFo] = useState(clip.fadeOut);
  useEffect(() => { setGain(clip.gainDb); setFi(clip.fadeIn); setFo(clip.fadeOut); }, [clip.id, clip.gainDb, clip.fadeIn, clip.fadeOut]);
  const set = (patch: Partial<EditClip>) => ed().commit((x) => updateClip(x, clip.id, patch));
  const maxFade = Math.max(0.05, Math.min(5, clip.duration / 2));
  const slider = (label: string, v: number, setV: (n: number) => void, min: number, max: number, step: number, unit: string, done: () => void) => (
    <label className="flex flex-col gap-1">
      <span className="flex justify-between font-mono text-[11px]"><span className="text-mute">{label}</span><span>{v > 0 && unit === 'dB' ? '+' : ''}{v.toFixed(unit === 'dB' ? 1 : 2)} {unit}</span></span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} onPointerUp={done} onKeyUp={done} />
    </label>
  );
  return (
    <Section title={t('edit.clip.title')} right={<span className="font-mono">{clip.duration.toFixed(2)}s</span>}>
      <span className="font-mono text-[11px] text-mute">{formatTime(clip.start)} – {formatTime(clipEnd(clip))}</span>
      {slider(t('edit.clip.gain'), gain, setGain, -30, 12, 0.5, 'dB', () => gain !== clip.gainDb && set({ gainDb: gain }))}
      {slider(t('edit.clip.fadeIn'), fi, setFi, 0, maxFade, 0.01, 's', () => fi !== clip.fadeIn && set({ fadeIn: fi }))}
      {slider(t('edit.clip.fadeOut'), fo, setFo, 0, maxFade, 0.01, 's', () => fo !== clip.fadeOut && set({ fadeOut: fo }))}
      {speakers.length > 0 && (
        <label className="flex items-center gap-2 text-[12px]">
          <span className="text-mute font-mono text-[11px]">{t('edit.clip.speaker')}</span>
          <select value={clip.speaker ?? ''} onChange={(e) => set({ speaker: e.target.value === '' ? null : Number(e.target.value) })}
            className="bg-bg text-fg border border-line3 flex-1 py-1.5 px-1">
            <option value="">—</option>
            {speakers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <Act onClick={() => ed().setSelection({ trackId: clip.trackId, start: clip.start, end: clipEnd(clip) })}>{t('edit.clip.select')}</Act>
        <Act onClick={() => ed().commit((x) => splitAt(x, playhead, [clip.trackId]))} disabled={playhead <= clip.start || playhead >= clipEnd(clip)}>⫼ {t('edit.clip.split')}</Act>
        <Act onClick={() => { ed().commit((x) => deleteClip(x, clip.id)); ed().selectClip(null); }}>✕ {t('edit.clip.delete')}</Act>
      </div>
    </Section>
  );
}

function SpeakersPanel({ trackId, canSplit }: { trackId: string | null; canSplit: boolean }) {
  const { t } = useTranslation();
  const speakers = useEdit((s) => s.timeline?.speakers ?? []);
  const assets = useEdit((s) => s.assets);
  const ed = useEdit.getState;
  const rename = (id: number, name: string) => ed().commit((x) => ({ ...x, speakers: x.speakers.map((s) => (s.id === id ? { ...s, name } : s)) }));
  const recolor = (id: number, color: string) => ed().commit((x) => ({ ...x, speakers: x.speakers.map((s) => (s.id === id ? { ...s, color } : s)) }));
  const split = (mode: 'cut' | 'tracks') => trackId && ed().commit((x) => splitBySpeakers(x, trackId, assets, mode, t('edit.speaker')));
  return (
    <Section title={t('edit.speakers.title')}>
      {speakers.map((s) => <SpeakerRow key={s.id} id={s.id} name={s.name} color={s.color} onName={rename} onColor={recolor} />)}
      {canSplit && trackId && (
        <div className="grid grid-cols-1 gap-1.5">
          <Act onClick={() => split('cut')}>{t('edit.speakers.cut')}</Act>
          <Act onClick={() => split('tracks')}>{t('edit.speakers.tracks')}</Act>
        </div>
      )}
      <span className="text-[11px] text-mute">{t('edit.speakers.hint')}</span>
    </Section>
  );
}

function SpeakerRow({ id, name, color, onName, onColor }: { id: number; name: string; color: string;
  onName: (id: number, n: string) => void; onColor: (id: number, c: string) => void }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <div className="flex items-center gap-2">
      <input type="color" value={color} onChange={(e) => onColor(id, e.target.value)} aria-label="color"
        className="w-6 h-6 p-0 border border-line3 bg-transparent cursor-pointer shrink-0" />
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== name && onName(id, v.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="bg-bg border border-line3 px-2 py-1 text-fg text-[13px] flex-1 min-w-0" />
    </div>
  );
}
