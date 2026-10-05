// Ô văn bản TTS có tô màu các đoạn gán giọng riêng. Bôi đen → chuột phải → chọn giọng/biến thể.
// Lớp tô màu nằm sau <textarea> trong suốt, cùng font/padding/cách xuống dòng, cuộn theo textarea.
import { useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Profile } from '../../api/types';
import { assignRange, clearRange, segmentAt, shiftSegments, type Segment } from '../../lib/segments';
import { VoicePicker } from './VoicePicker';

const PALETTE = ['#3BA3FF', '#2FD18B', '#E5C93B', '#C77DFF', '#FF6FA8', '#4FD1C5', '#F2994A', '#9AE65C'];

/** Màu cố định cho mỗi (giọng, biến thể) để cùng giọng luôn cùng màu. */
export function voiceColor(profileId: string, variantId: string | null) {
  let h = 0;
  for (const c of `${profileId}:${variantId ?? ''}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const FIELD = 'p-4 text-[16px] leading-[1.7] font-sans whitespace-pre-wrap break-words [overflow-wrap:anywhere] [scrollbar-gutter:stable]';

export function SegmentedText({ id, text, segments, voices, onChange, labelOf }: {
  id: string;
  text: string;
  segments: Segment[];
  /** Giọng chọn được trong menu (đọc văn bản được). */
  voices: Profile[];
  onChange: (text: string, segments: Segment[]) => void;
  /** Tên giọng · biến thể của một đoạn (popup khi rê chuột). */
  /** Tên giọng + tên biến thể của một đoạn (popup khi rê chuột). */
  labelOf: (s: Segment) => { voice: string; variant: string };
}) {
  const { t } = useTranslation();
  const area = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; start: number; end: number; current?: Segment } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; seg: Segment } | null>(null);

  // Textarea nằm trên lớp tô màu nên không nhận hover trực tiếp: dò xem con trỏ nằm trong hình chữ nhật nào của các <mark>.
  const onMove = (e: MouseEvent<HTMLTextAreaElement>) => {
    const marks = backdrop.current?.querySelectorAll<HTMLElement>('mark[data-seg]') ?? [];
    for (const m of marks) {
      for (const r of m.getClientRects()) {
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          const seg = segments.find((s) => s.id === m.dataset.seg);
          if (seg) return setHover({ x: e.clientX, y: e.clientY, seg });
        }
      }
    }
    if (hover) setHover(null);
  };

  const syncScroll = () => {
    if (backdrop.current && area.current) backdrop.current.scrollTop = area.current.scrollTop;
  };

  const onContext = (e: MouseEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    let start = el.selectionStart;
    let end = el.selectionEnd;
    let current: Segment | undefined;
    if (start === end) {
      // Không bôi đen: chuột phải trong một đoạn đã gán → sửa/bỏ cả đoạn đó.
      current = segmentAt(segments, start);
      if (!current) return; // để menu mặc định (dán, sao chép...)
      start = current.start;
      end = current.end;
    } else {
      // Bỏ khoảng trắng hai đầu vùng chọn để đoạn gọn.
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (start === end) return;
      current = segments.find((s) => s.start === start && s.end === end);
    }
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, start, end, current });
  };

  const close = () => {
    setMenu(null);
    area.current?.focus();
  };

  // Lớp tô màu: các đoạn gán giọng thành <mark>, phần còn lại giữ nguyên để vị trí chữ khớp textarea.
  const pieces: JSX.Element[] = [];
  let at = 0;
  for (const s of segments) {
    if (s.start > at) pieces.push(<span key={`t${at}`}>{text.slice(at, s.start)}</span>);
    const col = voiceColor(s.profileId, s.variantId);
    pieces.push(
      <mark key={s.id} data-seg={s.id} style={{ background: 'transparent', boxShadow: `inset 0 -2px 0 ${col}`, color: 'transparent' }}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  }
  pieces.push(<span key="tail">{text.slice(at)}{'\n'}</span>);

  const overlaps = menu ? segments.some((s) => s.start < menu.end && s.end > menu.start) : false;
  return (
    <div className="relative flex-grow flex flex-col min-h-[230px]">
      <div ref={backdrop} aria-hidden="true" className={`${FIELD} absolute inset-0 overflow-hidden text-transparent pointer-events-none`}>
        {pieces}
      </div>
      <textarea ref={area} id={id} value={text} rows={9} spellCheck={false}
        onChange={(e) => onChange(e.target.value, shiftSegments(segments, text, e.target.value))}
        onScroll={() => { syncScroll(); setHover(null); }} onContextMenu={(e) => { setHover(null); onContext(e); }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        className={`${FIELD} relative bg-transparent border-0 text-fg resize-y rounded-none flex-grow overflow-y-auto`} />
      {hover && !menu && (
        <div role="tooltip" className="fixed z-40 pointer-events-none bg-bg border px-3 py-2 whitespace-nowrap flex flex-col gap-0.5 shadow-[0_6px_20px_rgba(0,0,0,.6)]"
          style={{ left: hover.x + 14, top: hover.y + 18, borderColor: voiceColor(hover.seg.profileId, hover.seg.variantId) }}>
          <span className="text-[13px] font-bold">
            <span style={{ color: voiceColor(hover.seg.profileId, hover.seg.variantId) }}>◆</span> {labelOf(hover.seg).voice}
          </span>
          <span className="font-mono text-[11px]">
            <span className="text-mute">{t('variants.label')}: </span>{labelOf(hover.seg).variant}
          </span>
          <span className="font-mono text-[10px] text-mute">{t('tts.picker.rightClick')}</span>
        </div>
      )}
      {menu && (
        <VoicePicker x={menu.x} y={menu.y} voices={voices}
          excerpt={text.slice(menu.start, menu.end).replace(/\s+/g, ' ').slice(0, 40)}
          current={menu.current ? { profileId: menu.current.profileId, variantId: menu.current.variantId } : undefined}
          onPick={(c) => { onChange(text, assignRange(segments, menu.start, menu.end, c.profileId, c.variantId)); close(); }}
          onClear={overlaps ? () => { onChange(text, clearRange(segments, menu.start, menu.end)); close(); } : undefined}
          onClose={close} />
      )}
      <span className="sr-only">{t('tts.picker.hint')}</span>
    </div>
  );
}
