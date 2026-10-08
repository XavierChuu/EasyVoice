// Thao tác trên timeline của Edit Audio — hàm thuần (nhận timeline, trả timeline mới) để hoàn tác/làm lại bằng
// cách giữ các bản chụp, và để test được. Thời gian tính bằng giây.
//
// Ripple: "all" = xóa/chèn làm dịch mọi track (giữ đồng bộ giọng với nhạc nền), "track" = chỉ track đang sửa,
// "off" = không dịch (xóa để lại khoảng trống, chèn dài hơn thì ghi đè phần phía sau).

import type { EditAsset, EditClip, EditSpeaker, EditTimeline, EditTrack } from '../api/types';

export const EPS = 1e-4;
export const MIN_CLIP = 0.02;

export const TRACK_COLORS = ['#F2F2F2', '#7FB2FF', '#FFC857', '#8BE28B', '#FF8AD8', '#9FE6E0'];
export const SPEAKER_COLORS = ['#FF5B14', '#4DA3FF', '#4ADE80', '#FACC15', '#E879F9', '#2DD4BF', '#F87171', '#A78BFA'];

let seq = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const clipEnd = (c: EditClip) => c.start + c.duration;
export const timelineEnd = (t: EditTimeline) => t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function makeClip(p: Partial<EditClip> & Pick<EditClip, 'trackId' | 'assetId' | 'start' | 'duration'>): EditClip {
  return { id: newId('c'), offset: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, label: null, speaker: null, ...p };
}

export function makeTrack(t: EditTimeline, p: Partial<EditTrack> = {}): EditTrack {
  const n = t.tracks.length;
  return { id: newId('t'), name: `Audio ${n + 1}`, color: TRACK_COLORS[n % TRACK_COLORS.length], kind: 'audio', gainDb: 0,
    mute: false, solo: false, ...p };
}

export const speakerColor = (id: number) => SPEAKER_COLORS[id % SPEAKER_COLORS.length];

/** Thêm tên + màu mặc định cho người nói chưa có trong danh sách. */
export function ensureSpeakers(t: EditTimeline, ids: Iterable<number>, label = 'Người'): EditTimeline {
  const have = new Set(t.speakers.map((s) => s.id));
  const add: EditSpeaker[] = [];
  for (const id of ids) {
    if (have.has(id)) continue;
    have.add(id);
    add.push({ id, name: `${label} ${id + 1}`, color: speakerColor(id) });
  }
  return add.length ? { ...t, speakers: [...t.speakers, ...add].sort((a, b) => a.id - b.id) } : t;
}

// ---------------------------------------------------------------- cắt / dời
/** Tách clip tại thời điểm `at` (nằm trong clip). Fade ở mép cắt bị bỏ. */
export function splitClip(c: EditClip, at: number): [EditClip, EditClip] | null {
  if (at <= c.start + MIN_CLIP || at >= clipEnd(c) - MIN_CLIP) return null;
  const d = at - c.start;
  return [
    { ...c, duration: r4(d), fadeOut: 0 },
    { ...c, id: newId('c'), start: r4(at), offset: r4(c.offset + d), duration: r4(c.duration - d), fadeIn: 0 },
  ];
}

const onTracks = (ids: Set<string> | null) => (c: EditClip) => !ids || ids.has(c.trackId);

/** Tách mọi clip của các track tại `at`. */
export function splitAt(t: EditTimeline, at: number, trackIds: string[] | null = null): EditTimeline {
  const ids = trackIds ? new Set(trackIds) : null;
  const clips: EditClip[] = [];
  for (const c of t.clips) {
    const parts = onTracks(ids)(c) ? splitClip(c, at) : null;
    if (parts) clips.push(...parts);
    else clips.push(c);
  }
  return { ...t, clips };
}

/** Bỏ phần [s, e] của các clip trên các track (không dời). */
function cut(clips: EditClip[], ids: Set<string> | null, s: number, e: number): EditClip[] {
  const out: EditClip[] = [];
  for (const c of clips) {
    if (!onTracks(ids)(c) || clipEnd(c) <= s + EPS || c.start >= e - EPS) {
      out.push(c);
      continue;
    }
    if (c.start < s - MIN_CLIP) out.push({ ...c, duration: r4(s - c.start), fadeOut: 0 });
    if (clipEnd(c) > e + MIN_CLIP) {
      const d = e - c.start;
      out.push({ ...c, id: c.start < s - MIN_CLIP ? newId('c') : c.id, start: r4(e), offset: r4(c.offset + d), duration: r4(c.duration - d), fadeIn: 0 });
    }
  }
  return out;
}

function shift(clips: EditClip[], ids: Set<string> | null, at: number, delta: number): EditClip[] {
  return clips.map((c) => (onTracks(ids)(c) && c.start >= at - EPS ? { ...c, start: r4(Math.max(0, c.start + delta)) } : c));
}

function rippleTracks(t: EditTimeline, trackId: string | null): Set<string> | null {
  if (t.ripple === 'all' || trackId === null) return null;
  return new Set([trackId]);
}

/** Xóa khoảng [s, e]: trên mọi track nếu ripple "all" (hoặc không chỉ định track), còn lại chỉ track đó. */
export function deleteRange(t: EditTimeline, trackId: string | null, s: number, e: number): EditTimeline {
  if (e - s < EPS) return t;
  const ids = rippleTracks(t, trackId);
  let clips = cut(t.clips, ids, s, e);
  if (t.ripple !== 'off') clips = shift(clips, ids, e, -(e - s));
  return { ...t, clips };
}

/** Xóa nhiều khoảng (vd. mọi khoảng lặng dài) — làm từ cuối về đầu để vị trí phía trước không đổi. */
export function deleteRanges(t: EditTimeline, trackId: string | null, ranges: [number, number][]): EditTimeline {
  return [...ranges].sort((a, b) => b[0] - a[0]).reduce((acc, [s, e]) => deleteRange(acc, trackId, s, e), t);
}

/** Khoảng trống trên một track chứa thời điểm `at` (giữa hai clip, hoặc từ 0 tới clip đầu); không có thì null. */
export function gapAt(t: EditTimeline, trackId: string, at: number): [number, number] | null {
  const clips = t.clips.filter((c) => c.trackId === trackId);
  if (clips.some((c) => at >= c.start - EPS && at <= clipEnd(c) + EPS)) return null;
  const next = clips.filter((c) => c.start > at).reduce((m, c) => Math.min(m, c.start), Infinity);
  if (!Number.isFinite(next)) return null; // sau clip cuối: không có gì để kéo lại
  const prev = clips.filter((c) => clipEnd(c) < at).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  return next - prev > MIN_CLIP ? [r4(prev), r4(next)] : null;
}

/** Xóa một khoảng trống: kéo các clip phía sau lại. Ripple "all" dời cả các track khác (giữ đồng bộ), còn lại chỉ track đó. */
export function deleteGap(t: EditTimeline, trackId: string, s: number, e: number): EditTimeline {
  const out = deleteRange({ ...t, ripple: t.ripple === 'all' ? 'all' : 'track' }, trackId, s, e);
  return { ...out, ripple: t.ripple };
}

/**
 * "Đóng khoảng trống": trên mỗi track, các clip xếp liền nhau theo thứ tự bắt đầu — clip đầu giữ vị trí, các clip sau
 * bám vào cuối clip trước (bỏ cả chỗ chồng lấn). Trả lại đúng object cũ nếu không có gì đổi.
 */
export function closeGaps(t: EditTimeline, trackIds: string[] | null = null): EditTimeline {
  const ids = trackIds ? new Set(trackIds) : null;
  const moved = new Map<string, number>();
  for (const tr of t.tracks) {
    if (ids && !ids.has(tr.id)) continue;
    const clips = t.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    let end = clips.length ? clips[0].start : 0;
    for (const c of clips) {
      const start = r4(Math.max(0, end));
      if (Math.abs(start - c.start) > EPS) moved.set(c.id, start);
      end = (moved.get(c.id) ?? c.start) + c.duration;
    }
  }
  if (!moved.size) return t;
  return { ...t, clips: t.clips.map((c) => (moved.has(c.id) ? { ...c, start: moved.get(c.id)! } : c)) };
}

/** Chèn khoảng trống dài `dur` tại `at` trên các track. */
export function insertGap(t: EditTimeline, ids: Set<string> | null, at: number, dur: number): EditTimeline {
  const split = splitAt(t, at, ids ? [...ids] : null);
  return { ...split, clips: shift(split.clips, ids, at, dur) };
}

/**
 * Thay khoảng [s, e] của một track bằng clip mới (dài newClip.duration). Độ dài khác đoạn cũ thì dời theo ripple:
 * "all" chèn khoảng trống / bỏ bớt cùng chỗ ở các track khác để giữ đồng bộ; "off" thì ghi đè phần phía sau.
 */
export function replaceRange(t: EditTimeline, trackId: string, s: number, e: number,
  clip: Omit<EditClip, 'id' | 'trackId' | 'start'>): EditTimeline {
  const delta = clip.duration - (e - s);
  const own = new Set([trackId]);
  let clips = cut(t.clips, own, s, e);
  if (Math.abs(delta) > EPS) {
    if (t.ripple === 'off') {
      if (delta > 0) clips = cut(clips, own, e, e + delta);
    } else {
      clips = shift(clips, own, e, delta);
      if (t.ripple === 'all') {
        const others = new Set(t.tracks.map((x) => x.id).filter((id) => id !== trackId));
        if (delta > 0) {
          clips = splitAt({ ...t, clips }, e, [...others]).clips;
          clips = shift(clips, others, e, delta);
        } else {
          clips = cut(clips, others, e + delta, e);
          clips = shift(clips, others, e, delta);
        }
      }
    }
  }
  clips.push({ ...clip, id: newId('c'), trackId, start: r4(s) });
  return { ...t, clips };
}

/** Đoạn asset nằm dưới khoảng [s, e] của một track (để gửi đi lọc / đổi giọng). */
export interface RangeSegment {
  clipId: string;
  assetId: string;
  offset: number;
  duration: number;
  start: number; // vị trí trên timeline
}

export function segmentsInRange(t: EditTimeline, trackId: string, s: number, e: number): RangeSegment[] {
  return t.clips
    .filter((c) => c.trackId === trackId && clipEnd(c) > s + EPS && c.start < e - EPS)
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      const a = Math.max(s, c.start);
      const b = Math.min(e, clipEnd(c));
      return { clipId: c.id, assetId: c.assetId, offset: r4(c.offset + a - c.start), duration: r4(b - a), start: r4(a) };
    })
    .filter((x) => x.duration > MIN_CLIP);
}

/** Thay từng đoạn bằng asset đã xử lý (cùng độ dài) — giữ gain / người nói / nhãn của clip gốc. */
export function replaceSegments(t: EditTimeline, trackId: string, segs: RangeSegment[], assetIds: string[]): EditTimeline {
  let out = t;
  segs.forEach((seg, i) => {
    const src = t.clips.find((c) => c.id === seg.clipId);
    const own = new Set([trackId]);
    const clips = cut(out.clips, own, seg.start, seg.start + seg.duration);
    clips.push(makeClip({ trackId, assetId: assetIds[i], start: seg.start, duration: seg.duration, gainDb: src?.gainDb ?? 0,
      speaker: src?.speaker ?? null, label: src?.label ?? null }));
    out = { ...out, clips };
  });
  return out;
}

// ---------------------------------------------------------------- clip / track
export function updateClip(t: EditTimeline, id: string, patch: Partial<EditClip>): EditTimeline {
  return { ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function moveClip(t: EditTimeline, id: string, start: number, trackId?: string): EditTimeline {
  return updateClip(t, id, { start: r4(Math.max(0, start)), ...(trackId ? { trackId } : {}) });
}

/** Kéo mép clip: không vượt quá phần audio có trong asset, không ngắn hơn MIN_CLIP. */
export function trimClip(t: EditTimeline, id: string, edge: 'start' | 'end', at: number, assetDuration: number): EditTimeline {
  const c = t.clips.find((x) => x.id === id);
  if (!c) return t;
  if (edge === 'start') {
    const lo = c.start - c.offset;
    const s = Math.min(Math.max(at, lo, 0), clipEnd(c) - MIN_CLIP);
    const d = s - c.start;
    return updateClip(t, id, { start: r4(s), offset: r4(c.offset + d), duration: r4(c.duration - d),
      fadeIn: Math.min(c.fadeIn, c.duration - d) });
  }
  const e = Math.max(c.start + MIN_CLIP, Math.min(at, c.start + assetDuration - c.offset));
  return updateClip(t, id, { duration: r4(e - c.start), fadeOut: Math.min(c.fadeOut, e - c.start) });
}

/** Nhân bản clip ngay sau chính nó; chỗ đó đã có clip khác thì đặt sang track mới. */
export function duplicateClip(t: EditTimeline, id: string): EditTimeline {
  const c = t.clips.find((x) => x.id === id);
  if (!c) return t;
  const at = clipEnd(c);
  const busy = t.clips.some((x) => x.trackId === c.trackId && x.start < at + c.duration - EPS && clipEnd(x) > at + EPS);
  let out = t;
  let trackId = c.trackId;
  if (busy) {
    const src = t.tracks.find((x) => x.id === c.trackId);
    const tr = makeTrack(t, { name: `${src?.name ?? 'Audio'} (2)`, kind: src?.kind ?? 'audio', color: src?.color });
    out = { ...t, tracks: [...t.tracks, tr] };
    trackId = tr.id;
  }
  return { ...out, clips: [...out.clips, { ...c, id: newId('c'), trackId, start: r4(at) }] };
}

export function deleteClip(t: EditTimeline, id: string): EditTimeline {
  return { ...t, clips: t.clips.filter((c) => c.id !== id) };
}

export function updateTrack(t: EditTimeline, id: string, patch: Partial<EditTrack>): EditTimeline {
  return { ...t, tracks: t.tracks.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
}

export function deleteTrack(t: EditTimeline, id: string): EditTimeline {
  return { ...t, tracks: t.tracks.filter((x) => x.id !== id), clips: t.clips.filter((c) => c.trackId !== id) };
}

/** Thêm asset thành clip mới ở cuối track (hoặc track mới nếu chưa có). */
export function appendAsset(t: EditTimeline, asset: EditAsset, trackId?: string, at?: number): EditTimeline {
  let out = t;
  let tid = trackId;
  // Đặt tại một vị trí mà track đó đã có clip chồng lên → đưa sang track mới, không đè audio cũ
  if (tid && at !== undefined && t.clips.some((c) => c.trackId === tid && c.start < at + asset.durationSec - EPS && clipEnd(c) > at + EPS)) tid = undefined;
  if (!tid || !t.tracks.some((x) => x.id === tid)) {
    const tr = makeTrack(t, { name: asset.name.slice(0, 40) || undefined });
    out = { ...t, tracks: [...t.tracks, tr] };
    tid = tr.id;
  }
  const end = out.clips.filter((c) => c.trackId === tid).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const start = at ?? end;
  return { ...out, clips: [...out.clips, makeClip({ trackId: tid, assetId: asset.id, start, duration: asset.durationSec, label: asset.name })] };
}

// ---------------------------------------------------------------- tách nhạc, người nói
/** Track gốc thành track Giọng (clip trỏ sang asset giọng); thêm track Nhạc nền ngay bên dưới, cùng vị trí. */
export function applySeparation(t: EditTimeline, trackId: string, pairs: Record<string, [string, string]>,
  names: { voice: string; music: string }): { timeline: EditTimeline; musicTrackId: string } {
  const src = t.tracks.find((x) => x.id === trackId);
  const music = makeTrack(t, { name: names.music, kind: 'music', color: '#FFC857' });
  const tracks: EditTrack[] = [];
  for (const x of t.tracks) {
    if (x.id === trackId) tracks.push({ ...x, name: src && /^Audio \d+$/.test(src.name) ? names.voice : x.name, kind: 'voice' }, music);
    else tracks.push(x);
  }
  const clips: EditClip[] = [];
  for (const c of t.clips) {
    const pair = c.trackId === trackId ? pairs[c.assetId] : undefined;
    if (!pair) {
      clips.push(c);
      continue;
    }
    clips.push({ ...c, assetId: pair[0] });
    clips.push({ ...c, id: newId('c'), trackId: music.id, assetId: pair[1], speaker: null, label: null });
  }
  return { timeline: { ...t, tracks, clips }, musicTrackId: music.id };
}

interface Piece {
  start: number;
  offset: number;
  duration: number;
  speaker: number;
}

/** Chia một clip theo lượt nói của asset: điểm cắt ở giữa khoảng nghỉ giữa hai người khác nhau. */
export function speakerPieces(c: EditClip, asset: EditAsset): Piece[] {
  const turns = (asset.turns ?? []).filter((x) => x.end > c.offset && x.start < c.offset + c.duration);
  if (!turns.length) return [];
  const cuts: { at: number; speaker: number }[] = [{ at: c.offset, speaker: turns[0].speaker }];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].speaker === turns[i - 1].speaker) continue;
    const at = (turns[i - 1].end + turns[i].start) / 2;
    if (at > c.offset + MIN_CLIP && at < c.offset + c.duration - MIN_CLIP) cuts.push({ at, speaker: turns[i].speaker });
  }
  return cuts.map((k, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].at : c.offset + c.duration;
    return { start: r4(c.start + k.at - c.offset), offset: r4(k.at), duration: r4(end - k.at), speaker: k.speaker };
  });
}

/**
 * Theo người nói: "cut" = cắt clip tại chỗ đổi giọng và tô màu theo người; "tracks" = mỗi người một track riêng,
 * clip giữ nguyên vị trí trên timeline (dễ theo dõi, chỉnh âm lượng từng người).
 */
export function splitBySpeakers(t: EditTimeline, trackId: string, assets: Record<string, EditAsset>, mode: 'cut' | 'tracks',
  label = 'Người'): EditTimeline {
  const ids = new Set<number>();
  const pieces: { c: EditClip; p: Piece }[] = [];
  const keep: EditClip[] = [];
  for (const c of t.clips) {
    const a = c.trackId === trackId ? assets[c.assetId] : undefined;
    const ps = a ? speakerPieces(c, a) : [];
    if (!ps.length) {
      keep.push(c);
      continue;
    }
    for (const p of ps) {
      ids.add(p.speaker);
      pieces.push({ c, p });
    }
  }
  if (!pieces.length) return t;
  let out = ensureSpeakers(t, ids, label);
  const piece = (c: EditClip, p: Piece, tid: string): EditClip => ({
    ...c, id: newId('c'), trackId: tid, start: p.start, offset: p.offset, duration: p.duration, speaker: p.speaker,
    fadeIn: 0, fadeOut: 0,
  });
  if (mode === 'cut') return { ...out, clips: [...keep, ...pieces.map(({ c, p }) => piece(c, p, trackId))] };
  const src = t.tracks.find((x) => x.id === trackId)!;
  const byId = new Map<number, EditTrack>();
  for (const id of [...ids].sort((a, b) => a - b)) {
    const sp = out.speakers.find((s) => s.id === id)!;
    byId.set(id, { ...makeTrack(out), name: sp.name, color: sp.color, kind: 'speaker', gainDb: src.gainDb });
  }
  const tracks: EditTrack[] = [];
  for (const x of out.tracks) {
    if (x.id === trackId) tracks.push(...byId.values());
    else tracks.push(x);
  }
  out = { ...out, tracks, clips: [...keep, ...pieces.map(({ c, p }) => piece(c, p, byId.get(p.speaker)!.id))] };
  // Clip không có lượt nói nào (vd. đoạn nhạc) của track gốc chuyển sang track của người đầu tiên
  const first = byId.values().next().value as EditTrack;
  return { ...out, clips: out.clips.map((c) => (c.trackId === trackId ? { ...c, trackId: first.id } : c)) };
}

// ---------------------------------------------------------------- lời thoại theo timeline
export interface TimelineWord {
  key: string;
  start: number;
  end: number;
  text: string;
  trackId: string;
  clipId: string;
  speaker: number | null;
}

export function timelineWords(t: EditTimeline, assets: Record<string, EditAsset>, trackId: string | null): TimelineWord[] {
  const out: TimelineWord[] = [];
  for (const c of t.clips) {
    if (trackId && c.trackId !== trackId) continue;
    const a = assets[c.assetId];
    if (!a?.words) continue;
    a.words.forEach((w, i) => {
      const mid = (w.start + w.end) / 2;
      if (mid < c.offset || mid >= c.offset + c.duration) return;
      const speaker = c.speaker ?? a.turns?.find((x) => x.start <= mid && mid < x.end)?.speaker ?? null;
      const start = Math.max(c.start, c.start + w.start - c.offset);
      const end = Math.min(clipEnd(c), c.start + w.end - c.offset);
      out.push({ key: `${c.id}:${i}`, start: r4(start), end: r4(end), text: w.text, trackId: c.trackId, clipId: c.id, speaker });
    });
  }
  return out.sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
}

/** Tiếng đệm thường gặp (vi + en). Whisper hay tự bỏ các tiếng này nên danh sách có thể ít hơn thực tế. */
const FILLERS = new Set(['ờ', 'ơ', 'ừ', 'ừm', 'ừ', 'ưm', 'à', 'ạ', 'ầy', 'hừm', 'hmm', 'hm', 'um', 'umm', 'uh', 'uhm', 'er', 'erm', 'ah', 'eh', 'mm']);

export const isFiller = (text: string) => FILLERS.has(text.toLowerCase().replace(/[.,!?…"“”'’:;-]/g, '').trim());

/** Khoảng thời gian của các từ đệm, gộp từ liền nhau, nới mép một chút để không còn hơi thở cụt. */
export function fillerRanges(words: TimelineWord[], pad = 0.03): [number, number][] {
  const out: [number, number][] = [];
  for (const w of words.filter((x) => isFiller(x.text))) {
    const s = r4(Math.max(0, w.start - pad));
    const e = r4(w.end + pad);
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = e;
    else out.push([s, e]);
  }
  return out;
}

export function formatTime(sec: number, precise = true): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${precise ? rest.toFixed(2).padStart(5, '0') : String(Math.floor(rest)).padStart(2, '0')}`;
}

/** Phạm vi xuất file: cả dự án, một track, hoặc một clip. */
export type ExportScope = { kind: 'all' } | { kind: 'track'; trackId: string } | { kind: 'clip'; clipId: string };

/**
 * Timeline con để xuất: track riêng (bỏ mute/solo, giữ nguyên vị trí trên timeline để ghép lại khớp dự án) hoặc một clip
 * (dời về 0 s, âm lượng / fade của clip và track giữ nguyên). Tên dự án thành "<dự án> - <track|clip>" → tên file xuất.
 */
const joinName = (a: string, b: string) => (a.trim().toLowerCase() === b.trim().toLowerCase() ? a : `${a} - ${b}`);

export function exportTimeline(t: EditTimeline, scope: ExportScope): EditTimeline {
  if (scope.kind === 'all') return t;
  if (scope.kind === 'track') {
    const track = t.tracks.find((x) => x.id === scope.trackId);
    if (!track) return t;
    return { ...t, name: joinName(t.name, track.name), tracks: [{ ...track, mute: false, solo: false }],
      clips: t.clips.filter((c) => c.trackId === track.id) };
  }
  const clip = t.clips.find((c) => c.id === scope.clipId);
  const track = clip && t.tracks.find((x) => x.id === clip.trackId);
  if (!clip || !track) return t;
  return { ...t, name: joinName(t.name, clip.label ?? track.name), tracks: [{ ...track, mute: false, solo: false }],
    clips: [{ ...clip, start: 0 }] };
}
