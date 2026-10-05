import { describe, expect, it } from 'vitest';

import { assignRange, buildParts, clearRange, segmentAt, shiftSegments, type Segment } from './segments';

const seg = (start: number, end: number, profileId = 'b', variantId: string | null = null): Segment => ({ id: `${start}`, start, end, profileId, variantId });
const spans = (segs: Segment[]) => segs.map((s) => [s.start, s.end, s.profileId]);

describe('assign / clear', () => {
  it('đè đoạn cũ và tách đôi khi gán vào giữa', () => {
    const s = assignRange([seg(0, 10)], 3, 6, 'c', null);
    expect(spans(s)).toEqual([[0, 3, 'b'], [3, 6, 'c'], [6, 10, 'b']]);
  });
  it('gộp đoạn liền kề cùng giọng', () => {
    expect(spans(assignRange([seg(0, 5)], 5, 9, 'b', null))).toEqual([[0, 9, 'b']]);
    expect(spans(assignRange([seg(0, 5)], 5, 9, 'b', 'happy'))).toHaveLength(2); // khác biến thể → không gộp
  });
  it('bỏ gán một phần', () => {
    expect(spans(clearRange([seg(0, 10)], 2, 4))).toEqual([[0, 2, 'b'], [4, 10, 'b']]);
  });
});

describe('shiftSegments', () => {
  const text = 'Hello WORLD here';
  const w = [seg(6, 11)]; // "WORLD"
  it('gõ trước đoạn → dịch', () => {
    expect(spans(shiftSegments(w, text, `Oh. ${text}`))).toEqual([[10, 15, 'b']]);
  });
  it('gõ sau đoạn → giữ nguyên', () => {
    expect(spans(shiftSegments(w, text, `${text}!!`))).toEqual([[6, 11, 'b']]);
  });
  it('gõ bên trong → đoạn dài ra', () => {
    expect(spans(shiftSegments(w, text, 'Hello WOR-LD here'))).toEqual([[6, 12, 'b']]);
  });
  it('xóa hết chữ của đoạn → bỏ đoạn', () => {
    expect(shiftSegments(w, text, 'Hello  here')).toEqual([]);
  });
  it('xóa lấn vào đầu đoạn → co lại', () => {
    expect(spans(shiftSegments(w, text, 'HelRLD here'))).toEqual([[3, 6, 'b']]);
  });
});

describe('buildParts', () => {
  it('phần không gán dùng giọng chính, bỏ phần chỉ có khoảng trắng', () => {
    const parts = buildParts('A one. B two. A three.', [seg(7, 14, 'b', 'angry')], 'a', null);
    expect(parts).toEqual([
      { text: 'A one. ', profileId: 'a', variantId: null },
      { text: 'B two. ', profileId: 'b', variantId: 'angry' },
      { text: 'A three.', profileId: 'a', variantId: null },
    ]);
    expect(buildParts('  ', [], 'a', null)).toEqual([]);
  });
  it('segmentAt', () => {
    expect(segmentAt([seg(2, 4)], 3)?.start).toBe(2);
    expect(segmentAt([seg(2, 4)], 4)).toBeUndefined();
  });
});
