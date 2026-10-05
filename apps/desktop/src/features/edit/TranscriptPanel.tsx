// Lời thoại theo timeline: bấm một từ để nghe từ đó, kéo / Shift+bấm để chọn nhiều từ (thành vùng chọn trên
// timeline) rồi xóa hoặc sửa lời như sửa văn bản. Tô màu theo người nói, đánh dấu tiếng đệm (ờ, ừm…).
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Btn } from '../../components/ui';
import { deleteRange, deleteRanges, fillerRanges, isFiller, speakerColor, timelineWords, type TimelineWord } from '../../lib/editTimeline';
import { useEdit } from '../../stores/edit';
import type { DialogKind } from './Inspector';

export function TranscriptPanel({ openDialog }: { openDialog: (d: DialogKind) => void }) {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const assets = useEdit((s) => s.assets);
  const selection = useEdit((s) => s.selection);
  const playhead = useEdit((s) => s.playhead);
  const trackId = useEdit((s) => s.trackId);
  const ed = useEdit.getState;
  const [filter, setFilter] = useState<string>('');
  const anchor = useRef<TimelineWord | null>(null);
  const dragging = useRef(false);

  const withWords = timeline.tracks.filter((tr) => timeline.clips.some((c) => c.trackId === tr.id && assets[c.assetId]?.words?.length));
  const words = useMemo(() => timelineWords(timeline, assets, filter || null), [timeline, assets, filter]);
  const fillers = useMemo(() => fillerRanges(words), [words]);
  const names = new Map(timeline.speakers.map((s) => [s.id, s]));

  const paragraphs = useMemo(() => {
    const out: TimelineWord[][] = [];
    for (const w of words) {
      const cur = out[out.length - 1];
      const last = cur?.[cur.length - 1];
      if (!cur || !last || w.speaker !== last.speaker || w.start - last.end > 1.5 || w.trackId !== last.trackId) out.push([w]);
      else cur.push(w);
    }
    return out;
  }, [words]);

  const selectWords = (a: TimelineWord, b: TimelineWord) => {
    const [x, y] = a.start <= b.start ? [a, b] : [b, a];
    ed().setSelection({ trackId: x.trackId, start: x.start, end: Math.max(y.end, x.end) });
  };
  const inSel = (w: TimelineWord) => selection && selection.trackId === w.trackId && w.start >= selection.start - 1e-3 && w.end <= selection.end + 1e-3;

  if (!withWords.length) {
    const track = timeline.tracks.find((x) => x.id === trackId);
    const ids = [...new Set(timeline.clips.filter((c) => c.trackId === trackId).map((c) => c.assetId))];
    return (
      <div className="border border-line px-4 py-6 flex flex-col items-start gap-3">
        <span className="font-mono text-[11px] tracking-label text-mute">{t('edit.transcript.title')}</span>
        <span className="text-soft">{t('edit.transcript.empty')}</span>
        {track && ids.length > 0 && (
          <Btn variant="outline" onClick={() => void ed().runOp({ op: 'transcribe', assetIds: ids, language: 'auto' }, t('edit.track.transcribe'))}>
            {t('edit.transcript.run', { name: track.name })}
          </Btn>
        )}
      </div>
    );
  }

  return (
    <div className="border border-line flex flex-col min-w-0">
      <div className="flex flex-wrap gap-2 items-center justify-between px-3.5 py-2 border-b border-line">
        <span className="font-mono text-[11px] tracking-label text-mute">{t('edit.transcript.title')} · {words.length}</span>
        <div className="flex flex-wrap gap-2 items-center">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="bg-bg text-fg border border-line3 py-1 px-1.5 text-[12px]">
            <option value="">{t('edit.transcript.allTracks')}</option>
            {withWords.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
          </select>
          {fillers.length > 0 && (
            <Btn variant="link" onClick={() => ed().commit((x) => deleteRanges(x, filter || null, fillers))}>
              [{t('edit.transcript.fillers', { count: fillers.length })}]
            </Btn>
          )}
          <Btn variant="link" onClick={() => openDialog('silences')}>[{t('edit.track.silences')}]</Btn>
        </div>
      </div>
      {selection && words.some(inSel) && (
        <div className="flex flex-wrap gap-2 items-center px-3.5 py-2 border-b border-line bg-[#141414]">
          <span className="text-[12px] text-mute flex-grow">“{words.filter(inSel).map((w) => w.text).join(' ').slice(0, 80)}”</span>
          <Btn variant="ghost" className="!min-h-[32px] !py-1" onClick={() => { ed().commit((x) => deleteRange(x, selection.trackId, selection.start, selection.end)); ed().setSelection(null); }}>
            ✕ {t('edit.sel.delete')}
          </Btn>
          <Btn variant="primary" className="!min-h-[32px] !py-1" onClick={() => openDialog('retext')}>{t('edit.sel.retext')}</Btn>
        </div>
      )}
      <div className="px-4 py-3 max-h-[320px] overflow-auto flex flex-col gap-3 leading-[1.9]"
        onMouseUp={() => { dragging.current = false; }} onMouseLeave={() => { dragging.current = false; }}>
        {paragraphs.map((p) => {
          const sp = p[0].speaker !== null ? names.get(p[0].speaker) : undefined;
          const color = sp?.color ?? (p[0].speaker !== null ? speakerColor(p[0].speaker) : undefined);
          return (
            <div key={p[0].key} className="flex gap-3">
              <span className="shrink-0 w-[92px] font-mono text-[10px] pt-1.5 truncate" style={{ color: color ?? '#8F8F8F' }}>
                {sp?.name ?? (p[0].speaker !== null ? `${t('edit.speaker')} ${p[0].speaker + 1}` : timeline.tracks.find((x) => x.id === p[0].trackId)?.name)}
              </span>
              <p className="m-0 flex-1 min-w-0">
                {p.map((w) => {
                  const active = playhead >= w.start && playhead < w.end;
                  const sel = inSel(w);
                  return (
                    <span key={w.key}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (e.shiftKey && anchor.current) return selectWords(anchor.current, w);
                        anchor.current = w;
                        dragging.current = true;
                        ed().setSelection(null);
                        ed().seek(w.start);
                      }}
                      onMouseEnter={() => dragging.current && anchor.current && anchor.current.key !== w.key && selectWords(anchor.current, w)}
                      className={`cursor-pointer px-[1px] ${sel ? 'bg-acc text-bg' : active ? 'text-acc' : 'hover:bg-line2'} ${isFiller(w.text) ? 'underline decoration-dotted decoration-mute' : ''}`}
                      style={!sel && color ? { textDecorationColor: color } : undefined}>
                      {w.text}{' '}
                    </span>
                  );
                })}
              </p>
            </div>
          );
        })}
      </div>
      <div className="px-3.5 py-2 border-t border-line text-[11px] text-mute">{t('edit.transcript.hint')}</div>
    </div>
  );
}
