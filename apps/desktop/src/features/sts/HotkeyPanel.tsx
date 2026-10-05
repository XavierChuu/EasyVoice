// Gán giọng cho phím 1-9 trước khi live; trong lúc live hiện phím đang giữ và giọng đang dùng.
import { useTranslation } from 'react-i18next';

import type { Profile } from '../../api/types';
import type { HotkeyMode } from './useLiveHotkeys';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function HotkeyPanel({ voices, hotkeys, onChange, active, mode, error, running, defaultName }: {
  voices: Profile[];
  hotkeys: Record<string, string>;
  onChange: (digit: string, profileId: string) => void;
  active: string | null;
  mode: HotkeyMode;
  error: string;
  running: boolean;
  defaultName: string;
}) {
  const { t } = useTranslation();
  const nameOf = (id?: string) => voices.find((v) => v.id === id)?.name;
  const current = active ? nameOf(hotkeys[active]) : defaultName;

  return (
    <section aria-label={t('sts.hk.title')} className="border border-line flex flex-col">
      <div className="flex justify-between items-center gap-3 flex-wrap px-3.5 py-2 border-b border-line font-mono text-[11px] tracking-[.08em] text-mute">
        <span>{t('sts.hk.title')}</span>
        {running && (
          <span>
            {t('sts.hk.now')}: <span className={active ? 'text-acc font-bold' : 'text-fg'}>{current || '—'}</span>
            {active && ` · [${active}]`}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
        {DIGITS.map((d) => {
          const on = active === d;
          const assigned = !!nameOf(hotkeys[d]);
          return (
            <label key={d} className={`flex items-center gap-2.5 px-3 py-2 border-b border-r border-line2 ${on ? 'bg-acc text-bg' : ''}`}>
              <span className={`font-mono font-bold text-[18px] w-7 h-7 inline-flex items-center justify-center border ${on ? 'border-bg' : assigned ? 'border-fg' : 'border-line3 text-mute'}`}>{d}</span>
              <select value={assigned ? hotkeys[d] : ''} onChange={(e) => onChange(d, e.target.value)} aria-label={t('sts.hk.slot', { key: d })}
                className={`flex-1 min-w-0 border-0 py-1.5 text-[13px] rounded-none cursor-pointer ${on ? 'bg-acc text-bg' : 'bg-bg text-fg'}`}>
                <option value="">{t('sts.hk.none')}</option>
                {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
          );
        })}
      </div>
      <div className="px-3.5 py-2.5 text-[12px] text-mute flex flex-col gap-0.5">
        <span>{t('sts.hk.hint')}</span>
        {mode === 'global' && <span>{t('sts.hk.global')}</span>}
        {mode === 'window' && <span className="text-acc">{t('sts.hk.window')}{error ? ` (${error})` : ''}</span>}
      </div>
    </section>
  );
}
