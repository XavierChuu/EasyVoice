// Ô tìm kiếm + nút LỌC + bảng lọc (giới tính, ngôn ngữ, quốc gia, vùng miền, khả năng, có biến thể) + sắp xếp.
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Gender, Profile, VoiceLang } from '../../api/types';
import { Icon } from '../../components/ui';
import { countryName, EMPTY_FILTER, filterCount, GENDERS, regionName, type VoiceFilter } from '../../lib/voiceTags';
import { useSettings } from '../../stores/settings';

export type VoiceSort = 'newest' | 'oldest' | 'name';

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`border px-2.5 py-1.5 cursor-pointer text-[13px] font-semibold min-h-[34px] ${on ? 'bg-fg text-bg border-fg' : 'bg-transparent text-fg border-line3 hover:border-fg'}`}>
      {children}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <span className="font-mono text-[10px] tracking-label text-mute uppercase">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export function VoiceFilters({ voices, query, onQuery, filter, onFilter, sort, onSort, shown }: {
  voices: Profile[];
  query: string;
  onQuery: (q: string) => void;
  filter: VoiceFilter;
  onFilter: (f: VoiceFilter) => void;
  sort: VoiceSort;
  onSort: (s: VoiceSort) => void;
  shown: number;
}) {
  const { t } = useTranslation();
  const uiLang = useSettings((s) => s.lang);
  const [open, setOpen] = useState(false);
  const n = filterCount(filter);
  const set = (patch: Partial<VoiceFilter>) => onFilter({ ...filter, ...patch });

  // Chỉ đưa ra các giá trị đang có trong thư viện giọng.
  const langs = [...new Set(voices.map((v) => v.language))] as VoiceLang[];
  const countries = [...new Set(voices.map((v) => v.country).filter(Boolean))] as string[];
  const regionPool = voices.filter((v) => v.region && (!filter.countries.length || (v.country && filter.countries.includes(v.country))));
  const regions = [...new Map(regionPool.map((v) => [v.region!, v.country])).entries()];

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-2 flex-wrap items-stretch">
        <label className="flex items-center gap-2.5 border border-line3 px-3 focus-within:border-fg flex-[1_1_320px] max-w-[560px]">
          <Icon d="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.6-4.6" size={16} className="text-mute shrink-0" />
          <input type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('voices.searchPlaceholder')}
            aria-label={t('voices.search')} className="no-ring flex-1 min-w-0 bg-transparent border-0 py-2.5 text-fg text-[15px] placeholder:text-dim" />
        </label>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className={`border px-4 cursor-pointer font-mono font-bold text-[12px] tracking-label min-h-[44px] inline-flex items-center gap-2 ${open || n ? 'border-fg text-fg' : 'border-line3 text-fg hover:border-fg'}`}>
          <Icon d="M3 5h18l-7 8v6l-4 2v-8z" size={14} />
          {t('voices.filter')}{n > 0 && <span className="bg-acc text-bg px-1.5">{n}</span>}
        </button>
        <select value={sort} onChange={(e) => onSort(e.target.value as VoiceSort)} aria-label={t('voices.sort.label')}
          className="bg-bg border border-line3 px-3 text-fg text-[13px] rounded-none min-h-[44px] cursor-pointer">
          {(['newest', 'oldest', 'name'] as const).map((s) => <option key={s} value={s}>{t(`voices.sort.${s}`)}</option>)}
        </select>
        {(query || n > 0) && (
          <span className="self-center font-mono text-[11px] text-mute whitespace-nowrap">{t('voices.showing', { shown, total: voices.length })}</span>
        )}
      </div>

      {open && (
        <div className="border border-line p-3.5 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Group label={t('tags.gender')}>
            {GENDERS.map((g: Gender) => <Chip key={g} on={filter.genders.includes(g)} onClick={() => set({ genders: toggle(filter.genders, g) })}>{t(`gender.${g}`)}</Chip>)}
          </Group>
          <Group label={t('wizard.language')}>
            {langs.map((l) => <Chip key={l} on={filter.langs.includes(l)} onClick={() => set({ langs: toggle(filter.langs, l) })}>{t(`lang.${l}`)}</Chip>)}
          </Group>
          <Group label={t('tags.country')}>
            {countries.length === 0 && <span className="text-[12px] text-mute">{t('voices.noTags')}</span>}
            {countries.map((c) => (
              <Chip key={c} on={filter.countries.includes(c)}
                onClick={() => set({ countries: toggle(filter.countries, c), regions: [] })}>{countryName(c, uiLang)}</Chip>
            ))}
          </Group>
          <Group label={t('tags.region')}>
            {regions.length === 0 && <span className="text-[12px] text-mute">{t('voices.noTags')}</span>}
            {regions.map(([r, c]) => <Chip key={r} on={filter.regions.includes(r)} onClick={() => set({ regions: toggle(filter.regions, r) })}>{regionName(t, c, r)}</Chip>)}
          </Group>
          <Group label={t('voices.capability')}>
            {(['tts', 'sts'] as const).map((c) => <Chip key={c} on={filter.caps.includes(c)} onClick={() => set({ caps: toggle(filter.caps, c) })}>{c.toUpperCase()}</Chip>)}
            <Chip on={filter.variantsOnly} onClick={() => set({ variantsOnly: !filter.variantsOnly })}>{t('voices.hasVariants')}</Chip>
          </Group>
          {n > 0 && (
            <div className="flex items-end">
              <button type="button" onClick={() => onFilter(EMPTY_FILTER)}
                className="bg-transparent border-0 p-0 text-acc cursor-pointer font-mono text-[12px] hover:text-acc2">[{t('voices.clearFilters')}]</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
