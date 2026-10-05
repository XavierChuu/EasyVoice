// Menu chuột phải trên đoạn văn bản đã bôi đen: tìm giọng + chọn biến thể để đọc riêng đoạn đó.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Profile } from '../../api/types';
import { fold } from '../../lib/text';
import { tagLabels } from '../../lib/voiceTags';
import { useSettings } from '../../stores/settings';
import { variantLabel } from '../voices/VariantEditor';

export interface VoiceChoice {
  profileId: string;
  variantId: string | null;
}

export function VoicePicker({ x, y, voices, excerpt, current, onPick, onClear, onClose }: {
  x: number;
  y: number;
  voices: Profile[];
  /** Đoạn đang chọn (hiển thị rút gọn ở đầu menu). */
  excerpt: string;
  current?: VoiceChoice;
  onPick: (c: VoiceChoice) => void;
  /** Có khi vùng chọn chạm đoạn đã gán giọng. */
  onClear?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const uiLang = useSettings((s) => s.lang);
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: x, top: y });

  // Mỗi lựa chọn = (giọng, biến thể); tìm theo tên giọng hoặc tên biến thể, không phân biệt dấu.
  const options = useMemo(() => {
    const q = fold(query.trim());
    return voices.flatMap((v) => {
      const all = [{ v, variantId: null as string | null, label: t('variants.standard') },
        ...v.variants.map((x) => ({ v, variantId: x.id as string | null, label: variantLabel(t, x) }))];
      if (!q) return all;
      const tg = tagLabels(t, v, uiLang);
      if (fold([v.name, tg.gender, tg.country, tg.region].join(' ')).includes(q)) return all;
      return all.filter((o) => o.variantId && fold(o.label).includes(q));
    });
  }, [voices, query, t, uiLang]);
  useEffect(() => setActive(0), [query]);

  // Giữ menu trong cửa sổ.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y, options.length]);

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('blur', onClose); };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') setActive((a) => Math.min(options.length - 1, a + 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (e.key === 'Enter' && options[active]) onPick({ profileId: options[active].v.id, variantId: options[active].variantId });
    else return;
    e.preventDefault();
  };

  let lastVoice = '';
  return (
    <div ref={ref} role="dialog" aria-label={t('tts.picker.aria')} onKeyDown={onKey}
      className="fixed z-50 bg-bg border border-fg w-[300px] max-h-[420px] flex flex-col shadow-[0_8px_30px_rgba(0,0,0,.6)]"
      style={pos}>
      <div className="px-3 pt-2.5 pb-2 border-b border-line flex flex-col gap-2">
        <span className="font-mono text-[10px] tracking-label text-mute truncate">{t('tts.picker.title')} · “{excerpt}”</span>
        <input autoFocus type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('tts.picker.search')}
          aria-label={t('tts.picker.search')}
          className="no-ring bg-bg border border-line3 px-2.5 py-2 text-fg text-[14px] rounded-none focus:border-fg placeholder:text-dim" />
      </div>
      <div role="listbox" className="overflow-auto flex-1">
        {options.length === 0 && <div className="px-3 py-3 text-[13px] text-mute">{t('tts.picker.none')}</div>}
        {options.map((o, i) => {
          const header = o.v.id !== lastVoice;
          lastVoice = o.v.id;
          const isCurrent = current?.profileId === o.v.id && current.variantId === o.variantId;
          return (
            <div key={`${o.v.id}:${o.variantId}`}>
              {header && <div className="px-3 pt-2 pb-1 text-[13px] font-bold border-t border-line2 first:border-t-0">{o.v.name}</div>}
              <button type="button" role="option" aria-selected={i === active} data-idx={i}
                onMouseEnter={() => setActive(i)} onClick={() => onPick({ profileId: o.v.id, variantId: o.variantId })}
                className={`w-full text-left border-0 pl-5 pr-3 py-1.5 cursor-pointer font-mono text-[12px] flex justify-between ${i === active ? 'bg-fg text-bg' : 'bg-transparent text-fg'}`}>
                <span>{o.variantId ? '◆' : '◇'} {o.label}</span>
                {isCurrent && <span className="opacity-70">✓</span>}
              </button>
            </div>
          );
        })}
      </div>
      {onClear && (
        <button type="button" onClick={onClear}
          className="border-0 border-t border-line bg-transparent text-acc text-left px-3 py-2.5 cursor-pointer font-mono text-[12px] hover:bg-line2">
          ✕ {t('tts.picker.clear')}
        </button>
      )}
    </div>
  );
}
