// Menu chuột phải của Edit Audio: trên vùng chọn, trên clip, hoặc chỗ trống của một track (và trên chữ đã chọn
// trong lời thoại). Gom các lệnh hay dùng để khỏi phải kéo xuống bảng thao tác.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { clipEnd, deleteClip, deleteRange, duplicateClip, formatTime, splitAt, updateClip } from '../../lib/editTimeline';
import { useEdit } from '../../stores/edit';
import type { DialogKind } from './Inspector';

export interface MenuRequest {
  x: number;
  y: number;
  trackId: string;
  time: number;
  clipId: string | null;
  /** Bấm chuột phải bên trong vùng chọn hiện tại. */
  inSelection: boolean;
}

interface Item {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}
type Entry = Item | 'sep' | { title: string };

export function ContextMenu({ req, onClose, openDialog, onImport, onRecord }: {
  req: MenuRequest; onClose: () => void; openDialog: (d: DialogKind) => void;
  onImport: (trackId: string, at: number) => void; onRecord: (trackId: string, at: number) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: req.x, y: req.y });
  const ed = useEdit.getState;
  const s = ed();
  const timeline = s.timeline!;
  const sel = req.inSelection ? s.selection : null;
  const clip = timeline.clips.find((c) => c.id === req.clipId);
  const speakers = timeline.speakers;

  // Giữ menu trong cửa sổ
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(req.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(req.y, window.innerHeight - r.height - 4)) });
  }, [req.x, req.y]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onClose = () => closeRef.current();
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    ref.current?.focus();
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, []);

  /** Lệnh xử lý đoạn: dùng vùng chọn, hoặc cả clip nếu bấm vào clip. */
  const onRange = (d: DialogKind) => () => {
    if (!sel && clip) ed().setSelection({ trackId: clip.trackId, start: clip.start, end: clipEnd(clip) });
    openDialog(d);
  };
  const process: Entry[] = [
    { title: t('edit.sel.process') },
    { label: t('edit.sel.filter'), onClick: onRange('filter') },
    { label: t('edit.sel.retext'), onClick: onRange('retext') },
    { label: t('edit.sel.convert'), onClick: onRange('convert') },
    { label: t('edit.sel.speak'), onClick: onRange('speak') },
    { label: t('edit.sel.replace'), onClick: onRange('replace') },
  ];

  let entries: Entry[];
  if (sel) {
    entries = [
      { title: `${formatTime(sel.start)} – ${formatTime(sel.end)} · ${(sel.end - sel.start).toFixed(2)}s` },
      { label: `▶ ${t('edit.sel.play')}`, onClick: () => ed().play(sel.start, sel.end) },
      { label: t('edit.menu.split'), onClick: () => ed().commit((x) => splitAt(splitAt(x, sel.start, [sel.trackId]), sel.end, [sel.trackId])) },
      { label: t('edit.menu.silence'), hint: t('edit.menu.silenceHint'),
        onClick: () => ed().commit((x) => deleteRange({ ...x, ripple: 'off' }, sel.trackId, sel.start, sel.end)) },
      'sep',
      ...process,
      'sep',
      { label: t('edit.sel.clear'), hint: 'Esc', onClick: () => ed().setSelection(null) },
      { label: `✕ ${t('edit.sel.delete')}`, hint: 'Del', danger: true,
        onClick: () => { ed().commit((x) => deleteRange(x, sel.trackId, sel.start, sel.end)); ed().setSelection(null); } },
    ];
  } else if (clip) {
    const inside = req.time > clip.start + 0.02 && req.time < clipEnd(clip) - 0.02;
    const gain = (d: number) => ed().commit((x) => updateClip(x, clip.id, { gainDb: Math.max(-30, Math.min(12, Math.round((clip.gainDb + d) * 10) / 10)) }));
    const fade = Math.min(0.5, clip.duration / 4);
    entries = [
      { title: `${clip.label ?? s.assets[clip.assetId]?.name ?? 'Clip'} · ${clip.duration.toFixed(2)}s` },
      { label: `▶ ${t('edit.menu.playClip')}`, onClick: () => ed().play(clip.start, clipEnd(clip)) },
      { label: t('edit.menu.splitHere', { at: formatTime(req.time) }), hint: 'S', disabled: !inside,
        onClick: () => ed().commit((x) => splitAt(x, req.time, [clip.trackId])) },
      { label: t('edit.clip.select'), onClick: () => ed().setSelection({ trackId: clip.trackId, start: clip.start, end: clipEnd(clip) }) },
      { label: t('edit.menu.duplicate'), onClick: () => ed().commit((x) => duplicateClip(x, clip.id)) },
      'sep',
      ...process,
      'sep',
      { title: t('edit.menu.volume', { db: `${clip.gainDb > 0 ? '+' : ''}${clip.gainDb.toFixed(1)}` }) },
      { label: '+3 dB', onClick: () => gain(3) },
      { label: '−3 dB', onClick: () => gain(-3) },
      { label: clip.fadeIn || clip.fadeOut ? t('edit.menu.fadeOff') : t('edit.menu.fadeOn'),
        onClick: () => ed().commit((x) => updateClip(x, clip.id, clip.fadeIn || clip.fadeOut ? { fadeIn: 0, fadeOut: 0 } : { fadeIn: fade, fadeOut: fade })) },
      ...(speakers.length ? [
        'sep' as const, { title: t('edit.clip.speaker') },
        ...speakers.map((sp): Item => ({ label: `${clip.speaker === sp.id ? '● ' : ''}${sp.name}`, onClick: () => ed().commit((x) => updateClip(x, clip.id, { speaker: sp.id })) })),
        ...(clip.speaker !== null ? [{ label: t('edit.menu.noSpeaker'), onClick: () => ed().commit((x) => updateClip(x, clip.id, { speaker: null })) }] : []),
      ] : []),
      'sep',
      { label: `✕ ${t('edit.clip.delete')}`, hint: 'Del', danger: true, onClick: () => { ed().commit((x) => deleteClip(x, clip.id)); ed().selectClip(null); } },
    ];
  } else {
    entries = [
      { title: `${timeline.tracks.find((x) => x.id === req.trackId)?.name ?? ''} · ${formatTime(req.time)}` },
      { label: t('edit.menu.seekHere'), onClick: () => ed().seek(req.time) },
      { label: `▶ ${t('edit.menu.playHere')}`, onClick: () => ed().play(req.time) },
      'sep',
      { label: `+ ${t('edit.menu.importHere')}`, onClick: () => onImport(req.trackId, req.time) },
      { label: `● ${t('edit.menu.recordHere')}`, onClick: () => onRecord(req.trackId, req.time) },
      { label: t('edit.menu.speakHere'), onClick: () => { ed().seek(req.time); ed().selectTrack(req.trackId); ed().setSelection(null); openDialog('speak'); } },
    ];
  }

  return (
    <div ref={ref} role="menu" tabIndex={-1} aria-label={t('edit.menu.aria')} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // ↑ / ↓ chuyển giữa các lệnh
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
        items[next]?.focus();
      }}
      className="no-ring fixed z-50 min-w-[240px] outline-none max-h-[80vh] overflow-auto bg-bg border border-fg py-1 shadow-[0_8px_24px_rgba(0,0,0,.6)]"
      style={{ left: pos.x, top: pos.y }}>
      {entries.map((it, i) => {
        if (it === 'sep') return <div key={i} className="my-1 border-t border-line2" />;
        if ('title' in it) return <div key={i} className="px-3 pt-1.5 pb-1 font-mono text-[10px] tracking-label text-mute truncate">{it.title}</div>;
        return (
          <button key={i} type="button" role="menuitem" disabled={it.disabled}
            onClick={() => { onClose(); it.onClick(); }}
            className={`w-full flex justify-between gap-6 items-center text-left bg-transparent border-0 px-3 py-1.5 min-h-[32px] cursor-pointer text-[13px] hover:bg-fg hover:text-bg focus-visible:bg-fg focus-visible:text-bg focus-visible:outline-none ${it.danger ? 'text-acc' : 'text-fg'}`}>
            <span>{it.label}</span>
            {it.hint && <span className="font-mono text-[10px] opacity-60">{it.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
