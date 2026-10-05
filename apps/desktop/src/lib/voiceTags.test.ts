import { describe, expect, it } from 'vitest';

import type { Profile } from '../api/types';
import { EMPTY_FILTER, filterCount, matchVoice } from './voiceTags';

const voice = (p: Partial<Profile>): Profile => ({
  id: 'x', name: 'X', language: 'vi', createdAt: '', capabilities: ['tts'], trainJobId: null, imported: false, author: null,
  license: 'personal', hasRef: true, hasPreview: true, sampleRate: null, variants: [], gender: null, country: null, region: null, ...p,
});
const words = (p: Profile) => [p.name, p.gender === 'female' ? 'Nữ' : p.gender === 'male' ? 'Nam' : '', p.region ?? ''];

describe('matchVoice', () => {
  const lan = voice({ name: 'Lan', gender: 'female', country: 'VN', region: 'south' });
  const tom = voice({ name: 'Tom', language: 'en', gender: 'male', country: 'US', capabilities: ['tts', 'sts'] });

  it('lọc theo nhiều nhóm (AND giữa nhóm, OR trong nhóm)', () => {
    expect(matchVoice(lan, { ...EMPTY_FILTER, genders: ['female', 'other'] }, '', words)).toBe(true);
    expect(matchVoice(tom, { ...EMPTY_FILTER, genders: ['female'] }, '', words)).toBe(false);
    expect(matchVoice(tom, { ...EMPTY_FILTER, countries: ['US'], caps: ['sts'] }, '', words)).toBe(true);
    expect(matchVoice(lan, { ...EMPTY_FILTER, caps: ['sts'] }, '', words)).toBe(false);
    expect(matchVoice(lan, { ...EMPTY_FILTER, variantsOnly: true }, '', words)).toBe(false);
  });

  it('tìm không dấu, nhiều từ đều phải khớp', () => {
    expect(matchVoice(lan, EMPTY_FILTER, 'nu lan', words)).toBe(true);
    expect(matchVoice(lan, EMPTY_FILTER, 'nam lan', words)).toBe(false);
  });

  it('đếm số lựa chọn lọc', () => {
    expect(filterCount({ ...EMPTY_FILTER, genders: ['male'], variantsOnly: true })).toBe(2);
  });
});
