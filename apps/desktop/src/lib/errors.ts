import type { TFunction } from 'i18next';

import { EngineError } from '../api/types';

/** Lỗi luôn có mã + thông điệp dễ hiểu (spec mục 5). */
export function errorText(t: TFunction, err: unknown): string {
  if (err instanceof EngineError) {
    const detail = err.message !== err.code ? err.message : '';
    let text = t(`errors.${err.code}`, { detail });
    if (!detail) text = text.replace(/ \(\)/, '').replace(/:\s*$/, '');
    return `${text} [${err.code}]`;
  }
  return `${t('errors.UNKNOWN')} [UNKNOWN]`;
}
