// Đoạn văn bản gán giọng riêng trong ô TTS: khoảng ký tự [start, end) + giọng/biến thể.
// Các khoảng không chồng nhau, sắp theo start; sửa văn bản thì dịch/co giãn theo chỗ sửa.

import type { TtsPart } from '../api/types';

export interface Segment {
  id: string;
  start: number;
  end: number;
  profileId: string;
  variantId: string | null;
}

const sorted = (segs: Segment[]) => [...segs].sort((a, b) => a.start - b.start);
const nonEmpty = (segs: Segment[]) => segs.filter((s) => s.end > s.start);

/** Bỏ gán giọng trong [start, end): đoạn bị cắt giữa thì tách đôi. */
export function clearRange(segs: Segment[], start: number, end: number): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (s.end <= start || s.start >= end) out.push(s);
    else {
      if (s.start < start) out.push({ ...s, end: start });
      if (s.end > end) out.push({ ...s, id: `${s.id}b`, start: end });
    }
  }
  return sorted(nonEmpty(out));
}

/** Gán giọng cho [start, end): đè lên các đoạn cũ trong khoảng đó; đoạn liền kề cùng giọng thì gộp. */
export function assignRange(segs: Segment[], start: number, end: number, profileId: string, variantId: string | null): Segment[] {
  if (end <= start) return segs;
  const next = sorted([...clearRange(segs, start, end), { id: Math.random().toString(36).slice(2, 10), start, end, profileId, variantId }]);
  const merged: Segment[] = [];
  for (const s of next) {
    const last = merged[merged.length - 1];
    if (last && last.end === s.start && last.profileId === s.profileId && last.variantId === s.variantId) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * Văn bản đổi từ `before` sang `after` (gõ, dán, xóa): tìm vùng sửa bằng tiền tố/hậu tố chung rồi dịch các đoạn.
 * Gõ thêm bên trong một đoạn thì đoạn dài ra; xóa lấn vào đoạn thì đoạn co lại; xóa hết thì bỏ đoạn.
 */
export function shiftSegments(segs: Segment[], before: string, after: string): Segment[] {
  if (!segs.length || before === after) return segs;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let q = 0;
  while (q < max - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  const oldEnd = before.length - q; // vùng cũ [p, oldEnd) được thay bằng after[p, newEnd)
  const delta = after.length - before.length;
  const newEnd = oldEnd + delta;
  const map = (i: number, isEnd: boolean) => {
    if (i < p || (i === p && !isEnd)) return i;
    if (i >= oldEnd && !(i === oldEnd && isEnd && oldEnd === p)) return i + delta;
    // Nằm trong vùng bị thay: đầu đoạn kéo về chỗ bắt đầu sửa, cuối đoạn kéo tới hết phần mới.
    return isEnd ? newEnd : p;
  };
  return sorted(nonEmpty(segs.map((s) => ({ ...s, start: map(s.start, false), end: map(s.end, true) }))));
}

/** Đoạn chứa vị trí con trỏ (để chuột phải vào một đoạn đã gán mà không cần bôi đen). */
export const segmentAt = (segs: Segment[], pos: number) => segs.find((s) => s.start <= pos && pos < s.end);

/** Tách văn bản thành các phần gửi engine: phần không gán dùng giọng chính. */
export function buildParts(text: string, segs: Segment[], profileId: string, variantId: string | null): TtsPart[] {
  const parts: TtsPart[] = [];
  const push = (t: string, pid: string, vid: string | null) => { if (t.trim()) parts.push({ text: t, profileId: pid, variantId: vid }); };
  let at = 0;
  for (const s of sorted(segs)) {
    const a = Math.max(at, Math.min(s.start, text.length));
    const b = Math.min(s.end, text.length);
    push(text.slice(at, a), profileId, variantId);
    push(text.slice(a, b), s.profileId, s.variantId);
    at = Math.max(at, b);
  }
  push(text.slice(at), profileId, variantId);
  return parts;
}
