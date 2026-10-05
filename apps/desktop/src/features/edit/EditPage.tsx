// Trang Edit Audio: chọn / tạo dự án → trình sửa nhiều track (timeline, lời thoại, bảng thao tác).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import { Btn, ConfirmModal, DropZone, PageHead, Segmented, TextInput } from '../../components/ui';
import { filesToRefs } from '../../components/RefClipInput';
import { deleteClip, deleteRange, formatTime, makeTrack, splitAt, timelineEnd } from '../../lib/editTimeline';
import { MEDIA_FILTER, platform } from '../../lib/platform';
import { formatDuration } from '../../lib/text';
import { useEdit } from '../../stores/edit';
import { Recorder } from '../voices/Recorder';
import { ConvertDialog, DuckDialog, ExportDialog, FilterDialog, ReplaceDialog, RetextDialog, SilencesDialog, SpeakDialog } from './dialogs';
import { Inspector, type DialogKind } from './Inspector';
import { Timeline } from './Timeline';
import { TranscriptPanel } from './TranscriptPanel';

export function EditPage() {
  const projectId = useEdit((s) => s.projectId);
  useEffect(() => () => useEdit.getState().pause(), []); // rời trang thì dừng phát
  return projectId ? <Editor /> : <ProjectPicker />;
}

function ProjectPicker() {
  const { t } = useTranslation();
  const list = useEdit((s) => s.list);
  const ed = useEdit.getState;
  const [name, setName] = useState('');
  const [recording, setRecording] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  useEffect(() => { void ed().refreshList(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (files = filesToRefs([]), source: 'import' | 'record' = 'import') =>
    void ed().create(name.trim() || files[0]?.name.replace(/\.[^.]+$/, '') || t('edit.untitled'), files, source);
  const pick = async () => {
    const files = await platform.pickFiles({ title: t('edit.import'), multiple: true, filters: [MEDIA_FILTER] });
    if (files.length) start(files);
  };

  return (
    <div className="flex flex-col gap-7">
      <PageHead code={t('edit.code')} title={t('edit.title')} desc={t('edit.desc')} />
      {engine().mode === 'mock' && <div className="text-[12px] text-mute font-mono">{t('edit.mockNote')}</div>}
      <div className="flex flex-wrap gap-4 items-start">
        <div className="flex-[2_1_420px] flex flex-col gap-4">
          <DropZone caption="AUDIO / VIDEO" text={t('edit.drop')} pad="p-10" onFiles={(f) => f.length && start(filesToRefs(f))}>
            <Btn variant="outline" onClick={() => void pick()}>{t('edit.import')}</Btn>
            <Btn variant="ghost" onClick={() => setRecording(true)}>● {t('edit.record')}</Btn>
            <Btn variant="ghost" onClick={() => start()}>{t('edit.empty')}</Btn>
          </DropZone>
          <TextInput label={t('edit.nameOptional')} value={name} onChange={setName} placeholder={t('edit.untitled')} />
        </div>
        <div className="flex-[1_1_300px] border border-line flex flex-col">
          <div className="px-3.5 py-2 border-b border-line font-mono text-[11px] tracking-label text-mute">{t('edit.recent')}</div>
          {list === null && <div className="px-3.5 py-3 text-mute text-[13px]">{t('common.working')}</div>}
          {list?.length === 0 && <div className="px-3.5 py-3 text-mute text-[13px]">{t('edit.noProjects')}</div>}
          {list?.map((p) => (
            <div key={p.id} className="flex items-center border-b border-line2 last:border-b-0">
              <button type="button" onClick={() => void ed().open(p.id)} className="flex-1 text-left bg-transparent border-0 px-3.5 py-2.5 cursor-pointer text-fg hover:bg-line2 min-w-0">
                <span className="block font-semibold truncate">{p.name}</span>
                <span className="block font-mono text-[11px] text-mute">
                  {formatDuration(p.durationSec)} · {t('edit.trackCount', { count: p.tracks })} · {new Date(p.updatedAt * 1000).toLocaleString()}
                </span>
              </button>
              <button type="button" onClick={() => setConfirmDel(p.id)} aria-label={t('common.remove')}
                className="bg-transparent border-0 text-mute hover:text-acc cursor-pointer px-3 min-h-[44px]">✕</button>
            </div>
          ))}
        </div>
      </div>
      {recording && <Recorder maxSec={3600} minSec={0.5} onClose={() => setRecording(false)}
        onDone={(ref) => { setRecording(false); start([ref], 'record'); }} />}
      {confirmDel && (
        <ConfirmModal title={t('edit.deleteTitle')} body={t('edit.deleteBody')} confirmLabel={t('common.remove')} danger
          onConfirm={() => void ed().remove(confirmDel)} onClose={() => setConfirmDel(null)} />
      )}
    </div>
  );
}

function Editor() {
  const { t } = useTranslation();
  const timeline = useEdit((s) => s.timeline)!;
  const playing = useEdit((s) => s.playing);
  const playhead = useEdit((s) => s.playhead);
  const pps = useEdit((s) => s.pxPerSec);
  const selection = useEdit((s) => s.selection);
  const past = useEdit((s) => s.past.length);
  const future = useEdit((s) => s.future.length);
  const saveState = useEdit((s) => s.saveState);
  const ed = useEdit.getState;
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [recording, setRecording] = useState(false);
  const [name, setName] = useState(timeline.name);
  useEffect(() => setName(timeline.name), [timeline.name]);

  // Phím tắt (không áp dụng khi đang gõ chữ hoặc đang mở hộp thoại)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (dialog || recording || el.closest('input, textarea, select, [role=dialog]')) return;
      const s = ed();
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') s.toggle();
      else if (mod && e.key.toLowerCase() === 'z') (e.shiftKey ? s.redo() : s.undo());
      else if (mod && e.key.toLowerCase() === 'y') s.redo();
      else if (e.key === 's' && !mod) s.commit((x) => splitAt(x, s.playhead, s.trackId ? [s.trackId] : null));
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selection) {
          const sel = s.selection;
          s.commit((x) => deleteRange(x, sel.trackId, sel.start, sel.end));
          s.setSelection(null);
        } else if (s.clipId) {
          const id = s.clipId;
          s.commit((x) => deleteClip(x, id));
          s.selectClip(null);
        } else return;
      } else if (e.key === 'Escape') { s.setSelection(null); s.selectClip(null); }
      else if (e.key === 'Home') s.seek(0);
      else if (e.key === '=' || e.key === '+') s.setZoom(s.pxPerSec * 1.25);
      else if (e.key === '-') s.setZoom(s.pxPerSec / 1.25);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, recording]); // eslint-disable-line react-hooks/exhaustive-deps

  const importPick = async () => {
    const files = await platform.pickFiles({ title: t('edit.import'), multiple: true, filters: [MEDIA_FILTER] });
    if (files.length) await ed().importFiles(files, 'import', { trackId: undefined, at: undefined });
  };
  const saveLabel = { saved: t('edit.save.saved'), saving: t('edit.save.saving'), dirty: t('edit.save.dirty'), error: t('edit.save.error') }[saveState];
  const end = timelineEnd(timeline);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-4 items-end justify-between border-b border-line pb-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] tracking-wide2 text-acc">{t('edit.code')}</div>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('edit.projectName')}
            onBlur={() => name.trim() && name !== timeline.name && ed().commit((x) => ({ ...x, name: name.trim() }))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="no-ring mt-1 bg-transparent border-0 border-b border-transparent focus:border-line3 p-0 text-[30px] font-bold leading-[1.15] text-fg w-full" />
          <span className="font-mono text-[11px] text-mute">{saveLabel}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn variant="ghost" onClick={() => ed().undo()} disabled={!past} title="Ctrl+Z">↶ {t('edit.undo')}</Btn>
          <Btn variant="ghost" onClick={() => ed().redo()} disabled={!future} title="Ctrl+Shift+Z">↷ {t('edit.redo')}</Btn>
          <Btn variant="ghost" onClick={() => ed().close()}>{t('edit.projects')}</Btn>
          <Btn variant="primary" onClick={() => setDialog('export')} disabled={!timeline.clips.length}>{t('edit.export.title')}</Btn>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex border border-line3">
          <button type="button" onClick={() => ed().toggle()} aria-label={playing ? t('common.stop') : t('common.play')}
            className={`border-0 px-4 min-h-[40px] font-mono font-bold cursor-pointer ${playing ? 'bg-fg text-bg' : 'bg-acc text-bg hover:bg-acc2'}`}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" onClick={() => { ed().pause(); ed().seek(0); }} aria-label="Home"
            className="border-0 border-l border-line3 px-3 min-h-[40px] bg-transparent text-fg cursor-pointer font-mono">⏮</button>
          <span className="px-3 flex items-center font-mono text-[13px] border-l border-line3 min-w-[170px]">
            {formatTime(playhead)} <span className="text-mute">&nbsp;/ {formatTime(end)}</span>
          </span>
        </div>
        <label className="flex items-center gap-2 font-mono text-[11px] text-mute">
          {t('edit.zoom')}
          <input type="range" min={Math.log(2)} max={Math.log(800)} step={0.01} value={Math.log(pps)} className="!w-28"
            onChange={(e) => ed().setZoom(Math.exp(Number(e.target.value)))} />
        </label>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-mute" title={t('edit.rippleHint')}>RIPPLE</span>
          <Segmented mono value={timeline.ripple} onChange={(ripple) => ed().commit((x) => ({ ...x, ripple }))} options={[
            { id: 'all', label: t('edit.ripple.all') }, { id: 'track', label: t('edit.ripple.track') }, { id: 'off', label: t('edit.ripple.off') },
          ]} />
        </div>
        <div className="flex gap-2 ml-auto flex-wrap">
          <Btn variant="ghost" onClick={() => void importPick()}>+ {t('edit.import')}</Btn>
          <Btn variant="ghost" onClick={() => setRecording(true)}>● {t('edit.record')}</Btn>
          <Btn variant="ghost" onClick={() => ed().commit((x) => ({ ...x, tracks: [...x.tracks, makeTrack(x)] }))}>+ {t('edit.addTrack')}</Btn>
          <Btn variant="ghost" onClick={() => setDialog('speak')}>{t('edit.sel.speak')}</Btn>
        </div>
      </div>

      <Timeline />
      <div className="font-mono text-[10px] text-mute -mt-3">{t('edit.shortcuts')}</div>

      <div className="flex flex-wrap gap-4 items-start">
        <div className="flex-[2_1_440px] min-w-0"><TranscriptPanel openDialog={setDialog} /></div>
        <div className="flex-[1_1_300px] min-w-0"><Inspector openDialog={setDialog} /></div>
      </div>

      {dialog === 'filter' && selection && <FilterDialog sel={selection} onClose={() => setDialog(null)} />}
      {dialog === 'retext' && selection && <RetextDialog sel={selection} onClose={() => setDialog(null)} />}
      {dialog === 'convert' && selection && <ConvertDialog sel={selection} onClose={() => setDialog(null)} />}
      {dialog === 'replace' && selection && <ReplaceDialog sel={selection} onClose={() => setDialog(null)} />}
      {dialog === 'speak' && <SpeakDialog sel={selection} onClose={() => setDialog(null)} />}
      {dialog === 'silences' && <SilencesDialog onClose={() => setDialog(null)} />}
      {dialog === 'duck' && <DuckDialog onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      {recording && <Recorder maxSec={3600} minSec={0.3} onClose={() => setRecording(false)}
        onDone={(ref) => { setRecording(false); void ed().importFiles([ref], 'record', { trackId: ed().trackId ?? undefined, at: ed().playhead }); }} />}
    </div>
  );
}
