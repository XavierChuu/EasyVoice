// Nhập thẻ phân loại giọng: giới tính, quốc gia, vùng miền (gợi ý theo quốc gia, hoặc tự gõ).
import { useTranslation } from 'react-i18next';

import type { Gender, VoiceTags } from '../../api/types';
import { Label, Segmented } from '../../components/ui';
import { COUNTRIES, countryName, GENDERS, REGIONS } from '../../lib/voiceTags';
import { useSettings } from '../../stores/settings';

export function TagFields({ id, value, onChange }: { id: string; value: VoiceTags; onChange: (v: VoiceTags) => void }) {
  const { t } = useTranslation();
  const uiLang = useSettings((s) => s.lang);
  const country = value.country ?? '';
  const presets = REGIONS[country] ?? [];
  const countries = COUNTRIES.includes(country) || !country ? COUNTRIES : [country, ...COUNTRIES];
  const field = 'bg-bg border border-line3 p-2.5 text-fg text-[14px] rounded-none';

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4 items-end">
      <div className="flex flex-col gap-1.5">
        <Label>{t('tags.gender')}</Label>
        <Segmented value={value.gender ?? ''} onChange={(g) => onChange({ ...value, gender: (g || null) as Gender | null })}
          options={[{ id: '', label: '—' }, ...GENDERS.map((g) => ({ id: g, label: t(`gender.${g}`) }))]} />
      </div>
      <label className="flex flex-col gap-1.5">
        <Label>{t('tags.country')}</Label>
        <select id={`${id}-country`} value={country} className={field}
          onChange={(e) => onChange({ ...value, country: e.target.value || null, region: null })}>
          <option value="">—</option>
          {countries.map((c) => <option key={c} value={c}>{countryName(c, uiLang)} ({c})</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <Label>{t('tags.region')}</Label>
        {presets.length ? (
          <select id={`${id}-region`} value={value.region ?? ''} className={field}
            onChange={(e) => onChange({ ...value, region: e.target.value || null })}>
            <option value="">—</option>
            {presets.map((r) => <option key={r} value={r}>{t(`region.${r}`)}</option>)}
            {value.region && !presets.includes(value.region) && <option value={value.region}>{value.region}</option>}
          </select>
        ) : (
          <input id={`${id}-region`} type="text" value={value.region ?? ''} placeholder={t('tags.regionPlaceholder')} className={`${field} placeholder:text-dim`}
            onChange={(e) => onChange({ ...value, region: e.target.value || null })} />
        )}
      </label>
    </div>
  );
}
