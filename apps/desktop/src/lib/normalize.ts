// Xem trước chuẩn hóa văn bản trong UI (mock). Bộ chuẩn hóa thật nằm ở engine
// (services/tts/text_normalize_vi.py, Phase 1) — ở đây chỉ đủ để người dùng thấy app sẽ đọc thế nào.

import type { DictEntry, VoiceLang } from '../api/types';

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberToEnglish(n: number): string {
  if (n < 20) return EN_ONES[n];
  if (n < 100) return EN_TENS[Math.floor(n / 10)] + (n % 10 ? '-' + EN_ONES[n % 10] : '');
  if (n < 1000) return EN_ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToEnglish(n % 100) : '');
  for (const [size, word] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= size) {
      const rest = n % size;
      return numberToEnglish(Math.floor(n / size)) + ' ' + word + (rest ? ' ' + numberToEnglish(rest) : '');
    }
  }
  return String(n);
}

const VI_DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

function viBelowThousand(n: number, full: boolean): string {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  const out: string[] = [];
  if (h || full) out.push(VI_DIGITS[h], 'trăm');
  if (t === 0 && u && (h || full)) out.push('lẻ');
  if (t === 1) out.push('mười');
  else if (t > 1) out.push(VI_DIGITS[t], 'mươi');
  if (u) {
    if (u === 1 && t > 1) out.push('mốt');
    else if (u === 5 && t > 0) out.push('lăm');
    else if (u === 4 && t > 1) out.push('tư');
    else out.push(VI_DIGITS[u]);
  }
  return out.join(' ');
}

export function numberToVietnamese(n: number): string {
  if (n === 0) return 'không';
  const units = ['', 'nghìn', 'triệu', 'tỷ'];
  const groups: number[] = [];
  let x = n;
  while (x > 0) {
    groups.push(x % 1000);
    x = Math.floor(x / 1000);
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    parts.push(viBelowThousand(groups[i], i < groups.length - 1), units[i % 4]);
  }
  return parts.filter(Boolean).join(' ');
}

const ABBR: Record<VoiceLang, [RegExp, string][]> = {
  en: [[/\bNYC\b/g, 'New York City'], [/\bkm\b/g, 'kilometers'], [/\bDr\./g, 'Doctor'], [/\be\.g\./g, 'for example']],
  vi: [[/\bTP\.?\s?HCM\b/g, 'thành phố Hồ Chí Minh'], [/\bkm\b/g, 'ki lô mét'], [/\bkg\b/g, 'ki lô gam'],
    [/\bv\.v\./g, 'vân vân'], [/\bUBND\b/g, 'ủy ban nhân dân']],
  unknown: [],
};

export function normalizePreview(text: string, lang: VoiceLang, dict: DictEntry[] = []): DictEntry[] {
  const L: VoiceLang = lang === 'vi' ? 'vi' : 'en';
  const say = (n: number) => (L === 'vi' ? numberToVietnamese(n) : numberToEnglish(n));
  const found = new Map<string, string>();
  for (const d of dict) if (d.from && text.includes(d.from)) found.set(d.from, d.to);
  for (const m of text.matchAll(/(\d[\d.,]*)\s?%/g)) {
    const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
    found.set(m[0], `${say(n)} ${L === 'vi' ? 'phần trăm' : 'percent'}`);
  }
  for (const m of text.matchAll(/\$\s?(\d[\d,]*)/g)) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    found.set(m[0], `${say(n)} ${L === 'vi' ? 'đô la' : n === 1 ? 'dollar' : 'dollars'}`);
  }
  for (const m of text.matchAll(/(\d[\d.]*)\s?(đồng|VND|đ)(?!\p{L})/gu)) {
    found.set(m[0], `${say(parseInt(m[1].replace(/\./g, ''), 10))} đồng`);
  }
  for (const [re, to] of ABBR[L]) for (const m of text.matchAll(re)) found.set(m[0], to);
  for (const m of text.matchAll(/\b\d{1,9}\b/g)) {
    if (![...found.keys()].some((k) => k.includes(m[0]))) found.set(m[0], say(parseInt(m[0], 10)));
  }
  return [...found].map(([from, to]) => ({ from, to })).slice(0, 8);
}
