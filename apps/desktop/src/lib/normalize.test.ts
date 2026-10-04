import { describe, expect, it } from 'vitest';

import { normalizePreview, numberToEnglish, numberToVietnamese } from './normalize';
import { slugify, splitSentences } from './text';

describe('numberToVietnamese', () => {
  it.each([
    [0, 'không'], [5, 'năm'], [10, 'mười'], [15, 'mười lăm'], [21, 'hai mươi mốt'], [24, 'hai mươi tư'],
    [105, 'một trăm lẻ năm'], [125, 'một trăm hai mươi lăm'], [1000, 'một nghìn'], [2026, 'hai nghìn không trăm hai mươi sáu'],
    [1_500_000, 'một triệu năm trăm nghìn'],
  ])('%i → %s', (n, s) => expect(numberToVietnamese(n)).toBe(s));
});

describe('numberToEnglish', () => {
  it.each([[0, 'zero'], [42, 'forty-two'], [125, 'one hundred twenty-five'], [2026, 'two thousand twenty-six']])(
    '%i → %s', (n, s) => expect(numberToEnglish(n)).toBe(s));
});

describe('normalizePreview', () => {
  it('reads percent and abbreviations in English', () => {
    const r = normalizePreview('Gold in NYC rose 10% today.', 'en');
    expect(r).toContainEqual({ from: '10%', to: 'ten percent' });
    expect(r).toContainEqual({ from: 'NYC', to: 'New York City' });
  });
  it('reads Vietnamese money and TP.HCM', () => {
    const r = normalizePreview('Vé 125.000đ tại TP.HCM', 'vi');
    expect(r).toContainEqual({ from: '125.000đ', to: 'một trăm hai mươi lăm nghìn đồng' });
    expect(r).toContainEqual({ from: 'TP.HCM', to: 'thành phố Hồ Chí Minh' });
  });
  it('applies the user dictionary', () => {
    expect(normalizePreview('EasyVoice dùng AI', 'vi', [{ from: 'AI', to: 'ây ai' }])).toContainEqual({ from: 'AI', to: 'ây ai' });
  });
});

describe('text helpers', () => {
  it('splits sentences on punctuation and newlines', () => {
    expect(splitSentences('Xin chào. Bạn khỏe không?\nTốt!')).toEqual(['Xin chào.', 'Bạn khỏe không?', 'Tốt!']);
  });
  it('slugifies Vietnamese names', () => {
    expect(slugify('Giọng Đọc Tin Tức')).toBe('giong-doc-tin-tuc');
  });
});
