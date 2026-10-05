// Timeline nhiều track: thước thời gian, đầu track (tên, M/S, âm lượng), làn clip vẽ bằng canvas từ peaks.
// Thao tác: kéo thanh tiêu đề clip để di chuyển (kể cả sang track khác), kéo mép để cắt bớt, kéo trên thân để chọn
// vùng, bấm để đặt đầu phát. Ctrl/⌘ + cuộn để zoom quanh con trỏ. Thả file vào để nhập.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { EditClip, EditTimeline, EditTrack } from '../../api/types';
import { filesToRefs } from '../../components/RefClipInput';
import { PEAK_RATE, editAudio } from '../../lib/editPlayer';
import { clipEnd, formatTime, moveClip, speakerColor, timelineEnd, trimClip, updateTrack } from '../../lib/editTimeline';
import { useEdit } from '../../stores/edit';
import type { MenuRequest } from './ContextMenu';

export const HEADER_W = 196;
const RULER_H = 24;
const TRACK_H = 88;
const BAR_H = 16;
const EDGE_PX = 6;
const SNAP_PX = 7;
const ACC = '#FF5B14';
const TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

type Drag =
  | { kind: 'move'; clipId: string; t0: number; origStart: number; origTrack: string; moved: boolean; preview?: { start: number; trackId: string } }
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end'; preview?: number }
  | { kind: 'range'; trackId: string; t0: number; x0: number; moved: boolean }
  | { kind: 'seek' };

const dbToGain = (db: number) => Math.pow(10, db / 20);

function fmtTick(sec: number, step: number) {
  if (step < 1) return `${sec.toFixed(step < 0.1 ? 2 : 1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export function Timeline({ onMenu }: { onMenu?: (req: MenuRequest) => void }) {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const assets = useEdit((s) => s.assets);
  const pps = useEdit((s) => s.pxPerSec);
  const playhead = useEdit((s) => s.playhead);
  const playing = useEdit((s) => s.playing);
  const selection = useEdit((s) => s.selection);
  const clipId = useEdit((s) => s.clipId);
  const trackId = useEdit((s) => s.trackId);
  const audioVersion = useEdit((s) => s.audioVersion);
  const importing = useEdit((s) => s.importing);
  const ed = useEdit.getState;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Theo đầu phát khi đang phát
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = playhead * pps;
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 40);
  }, [playhead, playing, pps]);

  // Zoom bằng Ctrl/⌘ + cuộn, giữ nguyên thời điểm dưới con trỏ
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cur = useEdit.getState().pxPerSec;
      const at = (el.scrollLeft + e.clientX - rect.left) / cur;
      const next = Math.min(800, Math.max(2, cur * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      useEdit.getState().setZoom(next);
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, at * next - (e.clientX - rect.left)); });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Timeline hiển thị (có áp bản xem trước khi đang kéo)
  const shown: EditTimeline = useMemo(() => {
    if (drag?.kind === 'move' && drag.preview) return moveClip(timeline, drag.clipId, drag.preview.start, drag.preview.trackId);
    if (drag?.kind === 'trim' && drag.preview !== undefined) {
      const c = timeline.clips.find((x) => x.id === drag.clipId);
      const a = c && assets[c.assetId];
      return a ? trimClip(timeline, drag.clipId, drag.edge, drag.preview, a.durationSec) : timeline;
    }
    return timeline;
  }, [timeline, drag, assets]);

  const end = timelineEnd(shown);
  const contentW = Math.max(view.width, (end + Math.max(10, view.width / pps / 3)) * pps);

  const timeAt = (clientX: number) => {
    const r = content.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / pps);
  };
  const trackAtY = (clientY: number): EditTrack | undefined => {
    const r = content.current!.getBoundingClientRect();
    const i = Math.floor((clientY - r.top - RULER_H) / TRACK_H);
    return timeline.tracks[i];
  };
  const snapPoints = useMemo(() => {
    const pts = [0, playhead];
    for (const c of timeline.clips) pts.push(c.start, clipEnd(c));
    return pts;
  }, [timeline, playhead]);
  const snap = (v: number, exclude?: string) => {
    const pts = exclude ? [0, playhead, ...timeline.clips.filter((c) => c.id !== exclude).flatMap((c) => [c.start, clipEnd(c)])] : snapPoints;
    let best = v;
    let dist = SNAP_PX / pps;
    for (const p of pts) {
      if (Math.abs(p - v) < dist) {
        dist = Math.abs(p - v);
        best = p;
      }
    }
    return best;
  };

  const hit = (tr: EditTrack, at: number) =>
    [...timeline.clips].reverse().find((c) => c.trackId === tr.id && at >= c.start && at <= clipEnd(c));

  const onLaneDown = (e: RPointerEvent<HTMLDivElement>, tr: EditTrack) => {
    if (e.button !== 0) return;
    const at = timeAt(e.clientX);
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const c = hit(tr, at);
    e.currentTarget.setPointerCapture(e.pointerId);
    ed().selectTrack(tr.id);
    if (c && y < BAR_H) {
      ed().selectClip(c.id);
      setDrag({ kind: 'move', clipId: c.id, t0: at, origStart: c.start, origTrack: c.trackId, moved: false });
      return;
    }
    if (c && (Math.abs(at - c.start) * pps < EDGE_PX || Math.abs(at - clipEnd(c)) * pps < EDGE_PX)) {
      ed().selectClip(c.id);
      setDrag({ kind: 'trim', clipId: c.id, edge: Math.abs(at - c.start) < Math.abs(at - clipEnd(c)) ? 'start' : 'end' });
      return;
    }
    setDrag({ kind: 'range', trackId: tr.id, t0: at, x0: e.clientX, moved: false });
  };

  /** Chuột phải: trong vùng chọn → lệnh của vùng chọn; trên clip → chọn clip + lệnh của clip; chỗ trống → lệnh của track. */
  const onLaneMenu = (e: RMouseEvent<HTMLDivElement>, tr: EditTrack) => {
    e.preventDefault();
    if (!onMenu || dragRef.current) return;
    const at = timeAt(e.clientX);
    const sel = ed().selection;
    const inSelection = !!sel && sel.trackId === tr.id && at >= sel.start && at <= sel.end;
    const c = inSelection ? undefined : hit(tr, at);
    ed().selectTrack(tr.id);
    if (!inSelection) {
      ed().setSelection(null);
      ed().selectClip(c?.id ?? null);
    }
    onMenu({ x: e.clientX, y: e.clientY, trackId: tr.id, time: at, clipId: c?.id ?? null, inSelection });
  };

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return hover(e);
    const at = timeAt(e.clientX);
    if (d.kind === 'move') {
      const c = timeline.clips.find((x) => x.id === d.clipId)!;
      let start = Math.max(0, d.origStart + at - d.t0);
      const s1 = snap(start, c.id);
      const s2 = snap(start + c.duration, c.id) - c.duration;
      start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : s2;
      const target = trackAtY(e.clientY)?.id ?? d.origTrack;
      setDrag({ ...d, moved: d.moved || Math.abs(at - d.t0) * pps > 2 || target !== d.origTrack, preview: { start: Math.max(0, start), trackId: target } });
    } else if (d.kind === 'trim') {
      setDrag({ ...d, preview: snap(at, d.clipId) });
    } else if (d.kind === 'range') {
      const moved = d.moved || Math.abs(e.clientX - d.x0) > 3;
      if (moved) {
        const a = snap(d.t0);
        const b = snap(at);
        ed().setSelection({ trackId: d.trackId, start: Math.min(a, b), end: Math.max(a, b) });
      }
      setDrag({ ...d, moved });
    } else if (d.kind === 'seek') {
      ed().seek(at);
    }
  };

  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    if (d.kind === 'move' && d.moved && d.preview) {
      const p = d.preview;
      ed().commit((x) => moveClip(x, d.clipId, p.start, p.trackId));
    } else if (d.kind === 'move' && !d.moved) {
      ed().seek(timeAt(e.clientX));
    } else if (d.kind === 'trim' && d.preview !== undefined) {
      const c = timeline.clips.find((x) => x.id === d.clipId);
      const a = c && assets[c.assetId];
      const v = d.preview;
      if (a) ed().commit((x) => trimClip(x, d.clipId, d.edge, v, a.durationSec));
    } else if (d.kind === 'range' && !d.moved) {
      const tr = timeline.tracks.find((x) => x.id === d.trackId)!;
      const c = hit(tr, d.t0);
      ed().setSelection(null);
      ed().selectClip(c?.id ?? null);
      ed().seek(d.t0);
    }
  };

  const [cursor, setCursor] = useState('text');
  const hover = (e: RPointerEvent<HTMLDivElement>) => {
    const tr = trackAtY(e.clientY);
    if (!tr) return setCursor('default');
    const at = timeAt(e.clientX);
    const lane = e.clientY - content.current!.getBoundingClientRect().top - RULER_H - timeline.tracks.indexOf(tr) * TRACK_H;
    const c = hit(tr, at);
    if (c && lane < BAR_H) setCursor('grab');
    else if (c && (Math.abs(at - c.start) * pps < EDGE_PX || Math.abs(at - clipEnd(c)) * pps < EDGE_PX)) setCursor('ew-resize');
    else setCursor('text');
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const tr = trackAtY(e.clientY);
    void ed().importFiles(filesToRefs(files), 'import', { trackId: tr?.id, at: tr ? timeAt(e.clientX) : undefined });
  };

  return (
    <div className="border border-line flex min-w-0 select-none" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="shrink-0 border-r border-line" style={{ width: HEADER_W }}>
        <div className="border-b border-line px-3 flex items-center justify-between font-mono text-[10px] tracking-label text-mute" style={{ height: RULER_H }}>
          <span>{t('edit.tracks')}</span>
          <span>{formatTime(end, false)}</span>
        </div>
        {timeline.tracks.map((tr) => <TrackHeader key={tr.id} track={tr} selected={tr.id === trackId} />)}
      </div>
      <div ref={scroller} className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden"
        onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}>
        <div ref={content} className="relative" style={{ width: contentW }}
          onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setCursor('text')}>
          <Ruler view={view} pps={pps} duration={contentW / pps}
            onDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ kind: 'seek' }); ed().seek(timeAt(e.clientX)); }} />
          {shown.tracks.map((tr) => (
            <div key={tr.id} className="border-b border-line relative" style={{ height: TRACK_H, cursor: drag?.kind === 'move' ? 'grabbing' : cursor }}
              onPointerDown={(e) => onLaneDown(e, tr)} onContextMenu={(e) => onLaneMenu(e, tr)}>
              <Lane track={tr} timeline={shown} view={view} pps={pps} selectedClip={clipId} audioVersion={audioVersion}
                selection={selection?.trackId === tr.id ? selection : null} highlighted={tr.id === trackId} />
            </div>
          ))}
          {!shown.tracks.length && (
            <div className="flex items-center justify-center text-mute text-[13px]" style={{ height: TRACK_H }}>{importing ? t('edit.importing') : t('edit.emptyTimeline')}</div>
          )}
          <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: playhead * pps, width: 1, background: ACC }}>
            <div className="absolute -left-[4px] top-0 w-0 h-0 border-l-[4.5px] border-r-[4.5px] border-t-[6px] border-l-transparent border-r-transparent" style={{ borderTopColor: ACC }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackHeader({ track, selected }: { track: EditTrack; selected: boolean }) {
  const { t } = useTranslation();
  const ed = useEdit.getState;
  const [name, setName] = useState(track.name);
  const [gain, setGain] = useState(track.gainDb);
  useEffect(() => setName(track.name), [track.name]);
  useEffect(() => setGain(track.gainDb), [track.gainDb]);
  const set = (patch: Partial<EditTrack>) => ed().commit((x) => updateTrack(x, track.id, patch));
  const toggle = (on: boolean, label: string, onClick: () => void, title: string) => (
    <button type="button" onClick={onClick} aria-pressed={on} title={title}
      className={`w-6 h-6 border font-mono text-[10px] font-bold cursor-pointer ${on ? 'bg-fg text-bg border-fg' : 'bg-transparent text-mute border-line3 hover:text-fg'}`}>
      {label}
    </button>
  );
  return (
    <div className={`border-b border-line flex ${selected ? 'bg-[#141414]' : ''}`} style={{ height: TRACK_H }}
      onPointerDown={() => ed().selectTrack(track.id)}>
      <div className="w-1 shrink-0" style={{ background: track.color }} />
      <div className="flex-1 min-w-0 px-2.5 py-2 flex flex-col gap-1.5">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('edit.trackName')}
          onBlur={() => name.trim() && name !== track.name && set({ name: name.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="no-ring bg-transparent border-0 border-b border-transparent focus:border-line3 p-0 text-[13px] font-semibold text-fg w-full" />
        <div className="flex items-center gap-1.5">
          {toggle(track.mute, 'M', () => set({ mute: !track.mute }), t('edit.mute'))}
          {toggle(track.solo, 'S', () => set({ solo: !track.solo }), t('edit.solo'))}
          <span className="font-mono text-[10px] text-mute ml-auto">{t(`edit.kind.${track.kind}`)}</span>
        </div>
        <label className="flex items-center gap-1.5 font-mono text-[10px] text-mute">
          <input type="range" min={-24} max={12} step={0.5} value={gain} aria-label={t('edit.trackGain')}
            onChange={(e) => setGain(Number(e.target.value))}
            onPointerUp={() => gain !== track.gainDb && set({ gainDb: gain })}
            onKeyUp={() => gain !== track.gainDb && set({ gainDb: gain })} />
          <span className="w-10 text-right">{gain > 0 ? '+' : ''}{gain.toFixed(1)}</span>
        </label>
      </div>
    </div>
  );
}

function Ruler({ view, pps, duration, onDown }: { view: { left: number; width: number }; pps: number; duration: number;
  onDown: (e: RPointerEvent<HTMLCanvasElement>) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(view.width * dpr);
    c.height = Math.floor(RULER_H * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, view.width, RULER_H);
    const step = TICKS.find((s) => s * pps >= 70) ?? 600;
    const t0 = Math.floor(view.left / pps / step) * step;
    ctx.font = '10px "JetBrains Mono", monospace';
    for (let s = t0; s <= Math.min(duration, (view.left + view.width) / pps + step); s += step) {
      const x = Math.round(s * pps - view.left) + 0.5;
      ctx.fillStyle = '#3D3D3D';
      ctx.fillRect(x, RULER_H - 8, 1, 8);
      for (let k = 1; k < 5; k++) ctx.fillRect(Math.round(x + (k * step * pps) / 5), RULER_H - 3, 1, 3);
      ctx.fillStyle = '#8F8F8F';
      ctx.fillText(fmtTick(s, step), x + 3, 11);
    }
  }, [view, pps, duration]);
  return (
    <div className="sticky left-0 border-b border-line" style={{ width: view.width, height: RULER_H }}>
      <canvas ref={ref} onPointerDown={onDown} style={{ width: view.width, height: RULER_H, display: 'block', cursor: 'pointer' }} />
    </div>
  );
}

function Lane({ track, timeline, view, pps, selection, selectedClip, highlighted, audioVersion }: {
  track: EditTrack; timeline: EditTimeline; view: { left: number; width: number }; pps: number;
  selection: { start: number; end: number } | null; selectedClip: string | null; highlighted: boolean; audioVersion: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const speakers = timeline.speakers;
  const assets = useEdit((s) => s.assets);
  const draw = useCallback(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = view.width;
    c.width = Math.floor(W * dpr);
    c.height = Math.floor(TRACK_H * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, TRACK_H);
    if (highlighted) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(0, 0, W, TRACK_H);
    }
    const t0 = view.left / pps;
    const t1 = (view.left + W) / pps;
    const clips = timeline.clips.filter((x) => x.trackId === track.id && clipEnd(x) > t0 && x.start < t1);
    for (const clip of clips) drawClip(ctx, clip, track, speakers, assets[clip.assetId]?.name ?? '', view.left, pps, W, clip.id === selectedClip);
    if (selection) {
      const x0 = selection.start * pps - view.left;
      const x1 = selection.end * pps - view.left;
      ctx.fillStyle = 'rgba(255,91,20,0.16)';
      ctx.fillRect(x0, 0, x1 - x0, TRACK_H);
      ctx.fillStyle = ACC;
      ctx.fillRect(Math.round(x0), 0, 1, TRACK_H);
      ctx.fillRect(Math.round(x1), 0, 1, TRACK_H);
    }
  }, [track, timeline, view, pps, selection, selectedClip, highlighted, speakers, assets]);
  useEffect(() => { draw(); }, [draw, audioVersion]);
  return (
    <div className="sticky left-0" style={{ width: view.width, height: TRACK_H }}>
      <canvas ref={ref} style={{ width: view.width, height: TRACK_H, display: 'block' }} />
    </div>
  );
}

function drawClip(ctx: CanvasRenderingContext2D, clip: EditClip, track: EditTrack, speakers: { id: number; color: string; name: string }[],
  assetName: string, left: number, pps: number, W: number, selected: boolean) {
  const x0 = clip.start * pps - left;
  const x1 = clipEnd(clip) * pps - left;
  const sp = clip.speaker !== null ? speakers.find((s) => s.id === clip.speaker) : undefined;
  const color = sp?.color ?? (clip.speaker !== null ? speakerColor(clip.speaker) : track.color);
  ctx.fillStyle = '#121212';
  ctx.fillRect(x0, 0, x1 - x0, TRACK_H);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = color;
  ctx.fillRect(x0, 0, x1 - x0, BAR_H);
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), TRACK_H);
  ctx.clip();
  ctx.fillStyle = '#0A0A0A';
  ctx.font = 'bold 10px "JetBrains Mono", monospace';
  const label = `${sp ? `${sp.name} · ` : ''}${clip.label || assetName}${clip.gainDb ? ` · ${clip.gainDb > 0 ? '+' : ''}${clip.gainDb.toFixed(1)}dB` : ''}`;
  ctx.fillText(label, Math.max(x0, 0) + 4, 11.5);
  // waveform
  const peaks = editAudio.peaksOf(clip.assetId);
  const mid = BAR_H + (TRACK_H - BAR_H) / 2;
  const half = (TRACK_H - BAR_H) / 2 - 3;
  const gain = dbToGain(clip.gainDb + track.gainDb);
  if (peaks) {
    const from = Math.max(0, Math.floor(x0));
    const to = Math.min(W, Math.ceil(x1));
    for (let x = from; x < to; x++) {
      const tl = (x + left) / pps;
      const local = tl - clip.start;
      const a = clip.offset + local;
      const b0 = Math.floor(a * PEAK_RATE);
      const b1 = Math.max(b0 + 1, Math.floor((a + 1 / pps) * PEAK_RATE));
      let lo = 0, hi = 0, sq = 0, n = 0;
      for (let k = Math.max(0, b0); k < Math.min(peaks.min.length, b1); k++) {
        if (peaks.min[k] < lo) lo = peaks.min[k];
        if (peaks.max[k] > hi) hi = peaks.max[k];
        sq += peaks.rms[k] * peaks.rms[k];
        n++;
      }
      let env = gain;
      if (clip.fadeIn > 0 && local < clip.fadeIn) env *= local / clip.fadeIn;
      if (clip.fadeOut > 0 && local > clip.duration - clip.fadeOut) env *= Math.max(0, (clip.duration - local) / clip.fadeOut);
      const r = n ? Math.sqrt(sq / n) : 0;
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = color;
      const yHi = mid - Math.min(1, hi * env) * half;
      const yLo = mid - Math.max(-1, lo * env) * half;
      ctx.fillRect(x, yHi, 1, Math.max(1, yLo - yHi));
      ctx.globalAlpha = 1;
      const rr = Math.max(0.5, Math.min(1, r * env) * half);
      ctx.fillRect(x, mid - rr, 1, rr * 2);
    }
  } else {
    ctx.fillStyle = '#3D3D3D';
    ctx.fillRect(x0, mid, x1 - x0, 1);
  }
  // fade
  if (clip.fadeIn > 0 || clip.fadeOut > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    if (clip.fadeIn > 0) {
      ctx.moveTo(x0, TRACK_H);
      ctx.lineTo(x0 + clip.fadeIn * pps, BAR_H);
    }
    if (clip.fadeOut > 0) {
      ctx.moveTo(x1 - clip.fadeOut * pps, BAR_H);
      ctx.lineTo(x1, TRACK_H);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = selected ? ACC : '#2B2B2B';
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, TRACK_H - 1);
  ctx.lineWidth = 1;
}
