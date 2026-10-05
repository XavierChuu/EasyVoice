// Thẻ phân loại giọng: giới tính, quốc gia (mã ISO 3166 hai chữ), vùng miền (khóa gợi ý theo quốc gia hoặc tự gõ).
import type { Gender, Profile, VoiceLang } from '../api/types';
import { fold } from './text';

export const GENDERS: Gender[] = ['male', 'female', 'other'];

/** Quốc gia hay gặp, hiện trước trong danh sách (còn lại người dùng gõ mã). */
export const COUNTRIES = ['VN', 'US', 'GB', 'AU', 'CA', 'IN', 'SG', 'PH', 'JP', 'KR', 'CN', 'TW', 'TH', 'FR', 'DE', 'ES'];

/** Vùng miền gợi ý theo quốc gia (khóa → i18n `region.<khóa>`); quốc gia khác thì gõ tự do. */
export const REGIONS: Record<string, string[]> = {
  VN: ['north', 'central', 'south'],
  US: ['general', 'southern', 'newyork', 'midwest', 'california'],
  GB: ['rp', 'london', 'northern', 'scottish', 'welsh', 'irish'],
};

export const defaultCountry = (lang: VoiceLang) => (lang === 'vi' ? 'VN' : lang === 'en' ? 'US' : '');

export function countryName(code: string, uiLang: string): string {
  try {
    return new Intl.DisplayNames([uiLang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

type T = (k: string, o?: Record<string, unknown>) => string;

/** Vùng miền có khóa gợi ý thì dịch, còn lại hiển thị nguyên văn người dùng gõ. */
export function regionName(t: T, country: string | null | undefined, region: string | null | undefined): string {
  if (!region) return '';
  return REGIONS[country ?? '']?.includes(region) ? t(`region.${region}`) : region;
}

/** Nhãn thẻ của một giọng để hiển thị và tìm kiếm. */
export function tagLabels(t: T, p: Pick<Profile, 'gender' | 'country' | 'region'>, uiLang: string) {
  return {
    gender: p.gender ? t(`gender.${p.gender}`) : '',
    country: p.country ? countryName(p.country, uiLang) : '',
    region: regionName(t, p.country, p.region),
  };
}

export interface VoiceFilter {
  genders: Gender[];
  langs: VoiceLang[];
  countries: string[];
  regions: string[]; // giá trị region thô (khóa hoặc chữ người dùng gõ)
  caps: ('tts' | 'sts')[];
  variantsOnly: boolean;
}

export const EMPTY_FILTER: VoiceFilter = { genders: [], langs: [], countries: [], regions: [], caps: [], variantsOnly: false };

export const filterCount = (f: VoiceFilter) =>
  f.genders.length + f.langs.length + f.countries.length + f.regions.length + f.caps.length + (f.variantsOnly ? 1 : 0);

/** Lọc + tìm (không dấu) trên tên, biến thể, ngôn ngữ, giới tính, quốc gia, vùng miền. */
export function matchVoice(p: Profile, f: VoiceFilter, query: string, words: (p: Profile) => string[]): boolean {
  if (f.genders.length && !(p.gender && f.genders.includes(p.gender))) return false;
  if (f.langs.length && !f.langs.includes(p.language)) return false;
  if (f.countries.length && !(p.country && f.countries.includes(p.country))) return false;
  if (f.regions.length && !(p.region && f.regions.includes(p.region))) return false;
  if (f.caps.length && !f.caps.every((c) => p.capabilities.includes(c))) return false;
  if (f.variantsOnly && !p.variants.length) return false;
  const q = fold(query.trim());
  return !q || q.split(/\s+/).every((w) => fold(words(p).join(' ')).includes(w));
}
