import { describe, expect, it } from 'vitest';

import type { EditAsset, EditTimeline } from '../api/types';
import {
  applySeparation, closeGaps, deleteGap, deleteRange, duplicateClip, deleteRanges, exportTimeline, fillerRanges, makeClip, replaceRange, replaceSegments, segmentsInRange, splitAt,
  gapAt, splitBySpeakers, timelineEnd, timelineWords, trimClip,
} from './editTimeline';

const asset = (id: string, durationSec: number, extra: Partial<EditAsset> = {}): EditAsset => ({
  id, name: id, durationSec, sampleRate: 48000, source: 'import', language: null, words: null, turns: null, createdAt: 0, ...extra,
});

function tl(ripple: EditTimeline['ripple'] = 'all'): EditTimeline {
  return {
    name: 't', ripple, speakers: [],
    tracks: [
      { id: 'v', name: 'Giọng', color: '#fff', kind: 'voice', gainDb: 0, mute: false, solo: false },
      { id: 'm', name: 'Nhạc', color: '#fff', kind: 'music', gainDb: 0, mute: false, solo: false },
    ],
    clips: [
      { ...makeClip({ trackId: 'v', assetId: 'a', start: 0, duration: 10 }), id: 'cv' },
      { ...makeClip({ trackId: 'm', assetId: 'b', start: 0, duration: 10 }), id: 'cm' },
    ],
  };
}

const spans = (t: EditTimeline, track: string) =>
  t.clips.filter((c) => c.trackId === track).sort((a, b) => a.start - b.start).map((c) => [c.start, c.offset, c.duration]);

describe('editTimeline', () => {
  it('splits clips at a time on chosen tracks', () => {
    const t = splitAt(tl(), 4, ['v']);
    expect(spans(t, 'v')).toEqual([[0, 0, 4], [4, 4, 6]]);
    expect(spans(t, 'm')).toEqual([[0, 0, 10]]);
  });

  it('deletes a range with ripple all / track / off', () => {
    expect(spans(deleteRange(tl('all'), 'v', 2, 5), 'v')).toEqual([[0, 0, 2], [2, 5, 5]]);
    expect(spans(deleteRange(tl('all'), 'v', 2, 5), 'm')).toEqual([[0, 0, 2], [2, 5, 5]]); // nhạc giữ đồng bộ
    expect(spans(deleteRange(tl('track'), 'v', 2, 5), 'm')).toEqual([[0, 0, 10]]);
    expect(spans(deleteRange(tl('off'), 'v', 2, 5), 'v')).toEqual([[0, 0, 2], [5, 5, 5]]);
    const many = deleteRanges(tl('all'), null, [[1, 2], [6, 8]]);
    expect(timelineEnd(many)).toBeCloseTo(7);
    expect(spans(many, 'v')).toEqual([[0, 0, 1], [1, 2, 4], [5, 8, 2]]);
  });

  it('replaces a range with a longer clip and keeps other tracks in sync', () => {
    const t = replaceRange(tl('all'), 'v', 2, 3, { assetId: 'n', offset: 0, duration: 2, gainDb: 0, fadeIn: 0, fadeOut: 0, label: null, speaker: null });
    expect(spans(t, 'v')).toEqual([[0, 0, 2], [2, 0, 2], [4, 3, 7]]);
    expect(spans(t, 'm')).toEqual([[0, 0, 3], [4, 3, 7]]); // chèn khoảng trống 1 s ở nhạc tại cuối vùng sửa
    const shorter = replaceRange(tl('all'), 'v', 2, 4, { assetId: 'n', offset: 0, duration: 1, gainDb: 0, fadeIn: 0, fadeOut: 0, label: null, speaker: null });
    expect(spans(shorter, 'm')).toEqual([[0, 0, 3], [3, 4, 6]]);
    const over = replaceRange(tl('off'), 'v', 2, 3, { assetId: 'n', offset: 0, duration: 2, gainDb: 0, fadeIn: 0, fadeOut: 0, label: null, speaker: null });
    expect(spans(over, 'v')).toEqual([[0, 0, 2], [2, 0, 2], [4, 4, 6]]); // ghi đè, không dời
  });

  it('maps a selection to asset segments and swaps processed assets back', () => {
    const t = splitAt(tl(), 4, ['v']);
    const segs = segmentsInRange(t, 'v', 3, 6);
    expect(segs.map((s) => [s.assetId, s.offset, s.duration, s.start])).toEqual([['a', 3, 1, 3], ['a', 4, 2, 4]]);
    const out = replaceSegments(t, 'v', segs, ['x', 'y']);
    expect(out.clips.filter((c) => c.trackId === 'v').sort((a, b) => a.start - b.start).map((c) => [c.assetId, c.start, c.duration]))
      .toEqual([['a', 0, 3], ['x', 3, 1], ['y', 4, 2], ['a', 6, 4]]);
  });

  it('trims within the available audio', () => {
    const t = { ...tl(), clips: [{ ...makeClip({ trackId: 'v', assetId: 'a', start: 5, offset: 2, duration: 3 }), id: 'c' }] };
    expect(spans(trimClip(t, 'c', 'start', 0, 10), 'v')).toEqual([[3, 0, 5]]);
    expect(spans(trimClip(t, 'c', 'end', 50, 10), 'v')).toEqual([[5, 2, 8]]);
  });

  it('separates music into a synced track', () => {
    const { timeline, musicTrackId } = applySeparation(tl(), 'v', { a: ['va', 'ma'] }, { voice: 'Giọng', music: 'Nhạc nền' });
    expect(timeline.tracks.map((x) => x.id)).toEqual(['v', musicTrackId, 'm']);
    expect(timeline.clips.find((c) => c.trackId === 'v')?.assetId).toBe('va');
    expect(timeline.clips.find((c) => c.trackId === musicTrackId)?.assetId).toBe('ma');
  });

  it('cuts at speaker changes or splits speakers into tracks on the same timeline', () => {
    const assets = { a: asset('a', 10, { turns: [{ start: 0.5, end: 3, speaker: 0 }, { start: 3.4, end: 6, speaker: 1 }, { start: 6.2, end: 9, speaker: 0 }] }) };
    const cut = splitBySpeakers(tl(), 'v', assets, 'cut');
    expect(cut.clips.filter((c) => c.trackId === 'v').sort((a, b) => a.start - b.start).map((c) => [c.start, c.duration, c.speaker]))
      .toEqual([[0, 3.2, 0], [3.2, 2.9, 1], [6.1, 3.9, 0]]);
    expect(cut.speakers.map((s) => [s.id, s.name])).toEqual([[0, 'Người 1'], [1, 'Người 2']]);
    const tracks = splitBySpeakers(tl(), 'v', assets, 'tracks');
    expect(tracks.tracks.map((x) => x.name)).toEqual(['Người 1', 'Người 2', 'Nhạc']);
    const p1 = tracks.tracks[0].id;
    expect(tracks.clips.filter((c) => c.trackId === p1).map((c) => c.start).sort()).toEqual([0, 6.1]);
  });

  it('maps words to the timeline and finds fillers', () => {
    const assets = { a: asset('a', 10, { words: [{ start: 1, end: 1.3, text: 'Xin' }, { start: 1.4, end: 1.6, text: 'ờ,' }, { start: 5, end: 5.5, text: 'chào' }] }) };
    const t = deleteRange(tl('all'), 'v', 2, 4);
    const words = timelineWords(t, assets, 'v');
    expect(words.map((w) => [w.text, w.start])).toEqual([['Xin', 1], ['ờ,', 1.4], ['chào', 3]]);
    expect(fillerRanges(words)).toEqual([[1.37, 1.63]]);
  });

  it('duplicates a clip right after itself, or onto a new track when that spot is taken', () => {
    const t = { ...tl(), clips: [{ ...makeClip({ trackId: 'v', assetId: 'a', start: 0, duration: 2 }), id: 'c1' }] };
    const d = duplicateClip(t, 'c1');
    expect(spans(d, 'v')).toEqual([[0, 0, 2], [2, 0, 2]]);
    const busy = duplicateClip(d, 'c1');
    expect(busy.tracks.length).toBe(3);
    expect(spans(busy, busy.tracks[2].id)).toEqual([[2, 0, 2]]);
  });
});

describe('exportTimeline', () => {
  const base: EditTimeline = {
    name: 'Dự án', ripple: 'all', speakers: [],
    tracks: [{ id: 't1', name: 'Giọng', mute: true, solo: false, gainDb: 0, color: '#fff' } as never,
      { id: 't2', name: 'Nhạc', mute: false, solo: true, gainDb: 0, color: '#fff' } as never],
    clips: [makeClip({ id: 'c1', trackId: 't1', assetId: 'a', start: 5, duration: 2, label: 'Câu 1' }),
      makeClip({ id: 'c2', trackId: 't1', assetId: 'a', start: 9, duration: 1 }),
      makeClip({ id: 'c3', trackId: 't2', assetId: 'b', start: 0, duration: 30 })],
  };
  it('exports a whole track alone (even if muted), keeping positions', () => {
    const x = exportTimeline(base, { kind: 'track', trackId: 't1' });
    expect(x.name).toBe('Dự án - Giọng');
    expect(x.tracks).toHaveLength(1);
    expect(x.tracks[0]).toMatchObject({ id: 't1', mute: false, solo: false });
    expect(x.clips.map((c) => [c.id, c.start])).toEqual([['c1', 5], ['c2', 9]]);
  });
  it('exports one clip from 0 s with its own settings', () => {
    const x = exportTimeline(base, { kind: 'clip', clipId: 'c1' });
    expect(x.name).toBe('Dự án - Câu 1');
    expect(x.clips).toHaveLength(1);
    expect(x.clips[0]).toMatchObject({ id: 'c1', start: 0, duration: 2 });
    expect(x.tracks.map((t) => t.id)).toEqual(['t1']);
    expect(base.clips[0].start).toBe(5); // không sửa timeline gốc
  });
  it('does not repeat the name when track and project share it', () => {
    expect(exportTimeline({ ...base, name: 'Giọng' }, { kind: 'track', trackId: 't1' }).name).toBe('Giọng');
  });
  it('returns the project unchanged for scope all / unknown ids', () => {
    expect(exportTimeline(base, { kind: 'all' })).toBe(base);
    expect(exportTimeline(base, { kind: 'clip', clipId: 'zz' })).toBe(base);
  });

  it('finds and deletes an empty gap on a track', () => {
    const t = { ...tl('track'), clips: [...tl().clips.filter((c) => c.trackId === 'm'),
      { ...makeClip({ trackId: 'v', assetId: 'a', start: 1, duration: 2 }), id: 'a1' },
      { ...makeClip({ trackId: 'v', assetId: 'a', start: 5, duration: 2 }), id: 'a2' }] };
    expect(gapAt(t, 'v', 4)).toEqual([3, 5]);
    expect(gapAt(t, 'v', 0.5)).toEqual([0, 1]);
    expect(gapAt(t, 'v', 2)).toBeNull(); // trên clip
    expect(gapAt(t, 'v', 9)).toBeNull(); // sau clip cuối
    const d = deleteGap(t, 'v', 3, 5);
    expect(spans(d, 'v')).toEqual([[1, 0, 2], [3, 0, 2]]);
    expect(spans(d, 'm')).toEqual([[0, 0, 10]]); // ripple track: nhạc không đổi
    expect(d.ripple).toBe('track');
    expect(deleteGap({ ...t, ripple: 'off' }, 'v', 3, 5).ripple).toBe('off');
    expect(spans(deleteGap({ ...t, ripple: 'all' }, 'v', 3, 5), 'm')).toEqual([[0, 0, 3], [3, 5, 5]]);
  });

  it('closes gaps and overlaps per track, keeping the first clip in place', () => {
    const t = { ...tl(), clips: [
      { ...makeClip({ trackId: 'v', assetId: 'a', start: 6, duration: 1 }), id: 'b' },
      { ...makeClip({ trackId: 'v', assetId: 'a', start: 2, duration: 2 }), id: 'a' },
      { ...makeClip({ trackId: 'v', assetId: 'a', start: 6.5, duration: 1 }), id: 'c' },
      { ...makeClip({ trackId: 'm', assetId: 'b', start: 3, duration: 1 }), id: 'm1' },
      { ...makeClip({ trackId: 'm', assetId: 'b', start: 9, duration: 1 }), id: 'm2' },
    ] };
    const c = closeGaps(t);
    expect(spans(c, 'v').map((x) => x[0])).toEqual([2, 4, 5]);
    expect(spans(c, 'm').map((x) => x[0])).toEqual([3, 4]);
    expect(spans(closeGaps(t, ['v']), 'm').map((x) => x[0])).toEqual([3, 9]);
    expect(closeGaps(c)).toBe(c);
  });
});
