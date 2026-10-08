// Trạng thái trang Edit Audio: dự án đang mở, timeline + lịch sử hoàn tác, vùng chọn, phát nhạc, job đang chạy.
// Timeline do app giữ và tự lưu lên engine (sau mỗi thao tác ~0,8 s); asset do engine giữ (job tạo asset mới).
import { create } from 'zustand';

import { engine } from '../api/engine';
import type { EditAsset, EditOp, EditOpResult, EditProjectSummary, EditTimeline, FileRef, Job } from '../api/types';
import i18n from '../i18n';
import { editAudio } from '../lib/editPlayer';
import { appendAsset, closeGaps, deleteRanges, timelineEnd } from '../lib/editTimeline';
import { errorText } from '../lib/errors';
import { useEngine } from './engine';
import { usePlayer } from './player';
import { useSettings } from './settings';
import { useUi } from './ui';

const HISTORY = 100;

export interface Selection {
  trackId: string;
  start: number;
  end: number;
  /** Vùng chọn là một khoảng trống giữa các clip (bấm vào chỗ trống) — xóa thì kéo các clip phía sau lại. */
  gap?: boolean;
}

/** Tham số "Dọn khoảng lặng" — giữ lại để mở lại hộp thoại với giá trị cũ. */
export interface SilenceParams {
  scope: 'track' | 'all';
  thresholdDb: number;
  minSec: number;
  padBefore: number;
  padAfter: number;
}

/** Kết quả tìm khoảng lặng đang được xem trên timeline trước khi cắt. */
export interface SilenceReview {
  ranges: [number, number][];
  /** Khoảng người dùng bấm bỏ qua (không cắt). */
  skip: boolean[];
  /** Track được phân tích; null = mọi track. */
  trackId: string | null;
}

export interface PendingOp {
  jobId: string;
  label: string;
  apply?: (res: EditOpResult) => void | Promise<void>;
}

interface EditState {
  list: EditProjectSummary[] | null;
  projectId: string | null;
  assets: Record<string, EditAsset>;
  timeline: EditTimeline | null;
  past: EditTimeline[];
  future: EditTimeline[];
  selection: Selection | null;
  clipId: string | null;
  trackId: string | null;
  playhead: number;
  playing: boolean;
  pxPerSec: number;
  pending: PendingOp[];
  saveState: 'saved' | 'saving' | 'dirty' | 'error';
  audioVersion: number;
  importing: number;
  silenceParams: SilenceParams;
  silenceReview: SilenceReview | null;
  setSilenceReview: (r: SilenceReview | null) => void;
  toggleSilence: (i: number) => void;
  applySilences: () => void;
  refreshList: () => Promise<void>;
  open: (id: string) => Promise<void>;
  openProject: (p: { id: string; assets: EditAsset[] } & EditTimeline) => void;
  /** Mở kết quả TTS / đổi giọng trong Edit Audio và chuyển sang trang đó. */
  openFromJob: (jobId: string) => Promise<void>;
  create: (name: string, files?: FileRef[], source?: 'import' | 'record') => Promise<void>;
  close: () => void;
  remove: (id: string) => Promise<void>;
  commit: (fn: (t: EditTimeline) => EditTimeline) => void;
  undo: () => void;
  redo: () => void;
  setSelection: (sel: Selection | null) => void;
  selectClip: (id: string | null) => void;
  selectTrack: (id: string | null) => void;
  seek: (t: number) => void;
  play: (from?: number, to?: number) => void;
  pause: () => void;
  toggle: () => void;
  setZoom: (pxPerSec: number) => void;
  importFiles: (files: FileRef[], source: 'import' | 'record', place?: { trackId?: string; at?: number } | false) => Promise<EditAsset[]>;
  refreshAssets: () => Promise<void>;
  runOp: (op: EditOp, label: string, apply?: PendingOp['apply']) => Promise<string | null>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let raf = 0;

const notify = (err: unknown) => useUi.getState().setNotice(errorText(i18n.t.bind(i18n), err));

const keepTrack = (t: EditTimeline, id: string | null) => (t.tracks.some((x) => x.id === id) ? id : t.tracks[0]?.id ?? null);

const strip = (t: EditTimeline): EditTimeline => ({ name: t.name, tracks: t.tracks, clips: t.clips, speakers: t.speakers, ripple: t.ripple });

export const useEdit = create<EditState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    set({ saveState: 'dirty' });
    saveTimer = setTimeout(() => void flush(), 800);
  };

  const flush = async () => {
    const { projectId, timeline } = get();
    if (!projectId || !timeline) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    set({ saveState: 'saving' });
    try {
      await engine().saveEditProject(projectId, strip(timeline));
      if (get().projectId === projectId) set({ saveState: get().saveState === 'saving' ? 'saved' : get().saveState });
    } catch (err) {
      set({ saveState: 'error' });
      notify(err);
    }
  };

  const loadAudio = (assets: EditAsset[]) => {
    const pid = get().projectId;
    if (!pid) return;
    for (const a of assets) {
      if (editAudio.has(a.id)) continue;
      void editAudio.load(a.id, engine().editAssetUrl(pid, a.id)).then((b) => b && set({ audioVersion: get().audioVersion + 1 }));
    }
  };

  const tick = () => {
    if (!editAudio.playing) return;
    set({ playhead: editAudio.position() });
    raf = requestAnimationFrame(tick);
  };

  const restartIfPlaying = () => {
    if (!get().playing) return;
    const pos = editAudio.stop();
    get().play(pos);
  };

  return {
    list: null,
    projectId: null,
    assets: {},
    timeline: null,
    past: [],
    future: [],
    selection: null,
    clipId: null,
    trackId: null,
    playhead: 0,
    playing: false,
    pxPerSec: 60,
    pending: [],
    saveState: 'saved',
    audioVersion: 0,
    importing: 0,
    silenceParams: { scope: 'track', thresholdDb: -45, minSec: 0.8, padBefore: 0.25, padAfter: 0.25 },
    silenceReview: null,

    setSilenceReview: (silenceReview) => set({ silenceReview }),
    toggleSilence: (i) => {
      const r = get().silenceReview;
      if (r) set({ silenceReview: { ...r, skip: r.skip.map((v, k) => (k === i ? !v : v)) } });
    },
    applySilences: () => {
      const r = get().silenceReview;
      if (!r) return;
      const ranges = r.ranges.filter((_, i) => !r.skip[i]);
      if (ranges.length) get().commit((x) => deleteRanges(x, r.trackId, ranges));
      set({ silenceReview: null });
    },

    refreshList: async () => {
      try {
        set({ list: await engine().listEditProjects() });
      } catch (err) {
        set({ list: [] });
        notify(err);
      }
    },

    open: async (id) => {
      try {
        get().openProject(await engine().getEditProject(id, true));
      } catch (err) {
        notify(err);
      }
    },

    openProject: (p) => {
      get().pause();
      const assets = Object.fromEntries(p.assets.map((a) => [a.id, a]));
      set({ projectId: p.id, assets, timeline: strip(p), past: [], future: [], selection: null, clipId: null,
        trackId: p.tracks[0]?.id ?? null, playhead: 0, saveState: 'saved', pending: [], silenceReview: null });
      loadAudio(p.assets);
    },

    openFromJob: async (jobId) => {
      try {
        get().openProject(await engine().editFromJob(jobId));
        useUi.getState().setTab('edit');
      } catch (err) {
        notify(err);
      }
    },

    create: async (name, files, source = 'import') => {
      try {
        const p = await engine().createEditProject(name);
        get().openProject(p);
        if (files?.length) await get().importFiles(files, source);
        void get().refreshList();
      } catch (err) {
        notify(err);
      }
    },

    close: () => {
      get().pause();
      void flush();
      set({ projectId: null, timeline: null, assets: {}, past: [], future: [], selection: null, clipId: null, pending: [], silenceReview: null });
      void get().refreshList();
    },

    remove: async (id) => {
      try {
        await engine().deleteEditProject(id);
        if (get().projectId === id) set({ projectId: null, timeline: null });
        await get().refreshList();
      } catch (err) {
        notify(err);
      }
    },

    commit: (fn) => {
      const cur = get().timeline;
      if (!cur) return;
      let next = fn(cur);
      if (useSettings.getState().editCloseGaps) next = closeGaps(next);
      if (next === cur) return;
      const sel = get().selection;
      set({
        timeline: next,
        silenceReview: null, // vị trí khoảng lặng tìm được không còn đúng
        past: [...get().past, cur].slice(-HISTORY),
        future: [],
        selection: sel && next.tracks.some((x) => x.id === sel.trackId) ? sel : null,
        clipId: next.clips.some((c) => c.id === get().clipId) ? get().clipId : null,
        trackId: keepTrack(next, get().trackId),
      });
      scheduleSave();
      restartIfPlaying();
    },

    undo: () => {
      const { past, timeline } = get();
      if (!past.length || !timeline) return;
      const prev = past[past.length - 1];
      set({ timeline: prev, past: past.slice(0, -1), future: [timeline, ...get().future], clipId: null, trackId: keepTrack(prev, get().trackId),
        silenceReview: null });
      scheduleSave();
      restartIfPlaying();
    },

    redo: () => {
      const { future, timeline } = get();
      if (!future.length || !timeline) return;
      set({ timeline: future[0], future: future.slice(1), past: [...get().past, timeline], clipId: null, trackId: keepTrack(future[0], get().trackId),
        silenceReview: null });
      scheduleSave();
      restartIfPlaying();
    },

    setSelection: (selection) => set({ selection, ...(selection ? { trackId: selection.trackId } : {}) }),
    selectClip: (clipId) => {
      const c = get().timeline?.clips.find((x) => x.id === clipId);
      set({ clipId, ...(c ? { trackId: c.trackId } : {}) });
    },
    selectTrack: (trackId) => set({ trackId }),

    seek: (t) => {
      const v = Math.max(0, t);
      set({ playhead: v });
      if (get().playing) get().play(v);
    },

    play: (from, to) => {
      const t = get().timeline;
      if (!t) return;
      usePlayer.getState().stop();
      let start = from ?? get().playhead;
      if (start >= timelineEnd(t) - 0.01) start = 0;
      editAudio.play(t, start, () => set({ playing: false, playhead: editAudio.position() }), to);
      cancelAnimationFrame(raf);
      set({ playing: editAudio.playing, playhead: start });
      if (editAudio.playing) raf = requestAnimationFrame(tick);
    },

    pause: () => {
      cancelAnimationFrame(raf);
      if (editAudio.playing) set({ playhead: editAudio.stop() });
      set({ playing: false });
    },

    toggle: () => (get().playing ? get().pause() : get().play()),

    setZoom: (pxPerSec) => set({ pxPerSec: Math.min(800, Math.max(2, pxPerSec)) }),

    importFiles: async (files, source, place) => {
      const pid = get().projectId;
      if (!pid || !files.length) return [];
      set({ importing: get().importing + 1 });
      try {
        const added = await engine().addEditAssets(pid, files, source);
        set({ assets: { ...get().assets, ...Object.fromEntries(added.map((a) => [a.id, a])) } });
        loadAudio(added);
        if (place !== false) {
          get().commit((t) => added.reduce((acc, a, i) =>
            appendAsset(acc, a, i === 0 ? place?.trackId : undefined, i === 0 ? place?.at : undefined), t));
          const c = get().timeline?.clips.find((x) => x.assetId === added[0].id);
          if (c) set({ trackId: c.trackId });
        }
        return added;
      } catch (err) {
        notify(err);
        return [];
      } finally {
        set({ importing: Math.max(0, get().importing - 1) });
      }
    },

    refreshAssets: async () => {
      const pid = get().projectId;
      if (!pid) return;
      const list = await engine().editAssets(pid);
      if (get().projectId !== pid) return;
      set({ assets: Object.fromEntries(list.map((a) => [a.id, a])) });
      loadAudio(list);
    },

    runOp: async (op, label, apply) => {
      const pid = get().projectId;
      if (!pid) return null;
      try {
        if (saveTimer) await flush();
        const jobId = await engine().editOp(pid, op);
        set({ pending: [...get().pending, { jobId, label, apply }] });
        settlePending();
        useUi.getState().setNotice('');
        return jobId;
      } catch (err) {
        notify(err);
        return null;
      }
    },
  };
});

// Khi job của Edit Audio xong: nạp lại danh sách asset (job tạo asset mới) rồi áp kết quả vào timeline.
// Gọi cả khi danh sách job đổi lẫn ngay sau khi thêm job: job ngắn có thể đã xong trước khi app kịp ghi nhận.
function settlePending() {
  const jobs = useEngine.getState().jobs;
  for (const p of useEdit.getState().pending) {
    const job: Job | undefined = jobs[p.jobId];
    if (!job || !['done', 'failed', 'cancelled'].includes(job.status)) continue;
    useEdit.setState({ pending: useEdit.getState().pending.filter((x) => x.jobId !== p.jobId) });
    if (job.status === 'failed') {
      useUi.getState().setNotice(`${p.label}: ${i18n.t(`errors.${job.error ?? 'UNKNOWN'}`, { defaultValue: job.error ?? '' })} ${job.errorDetail ?? ''}`.trim());
      continue;
    }
    if (job.status !== 'done') continue;
    void (async () => {
      try {
        await useEdit.getState().refreshAssets();
        await p.apply?.((job.result ?? {}) as EditOpResult);
      } catch (err) {
        notify(err);
      }
    })();
  }
}

useEngine.subscribe((s, prev) => {
  if (s.jobs !== prev.jobs) settlePending();
});
