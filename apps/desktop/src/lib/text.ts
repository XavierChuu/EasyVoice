/** Tách câu để hiển thị tiến độ theo câu (engine tách lại bằng chunker riêng). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tên file an toàn từ tên giọng (bỏ dấu tiếng Việt). */
export function slugify(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'voice';
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// Chữ cái chỉ tiếng Việt mới có (đ, ơ, ư, ă + các dấu thanh trên nguyên âm có mũ/móc) — đủ để nhận ra văn bản tiếng Việt.
const VI_CHARS = /[đơưăạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

export const looksVietnamese = (text: string) => VI_CHARS.test(text);

/** Chuỗi để so khớp tìm kiếm: bỏ dấu, đ → d, chữ thường ("Giận Dữ" khớp "gian du"). */
export const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
