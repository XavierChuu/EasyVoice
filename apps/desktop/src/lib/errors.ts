import type { TFunction } from 'i18next';

import { EngineError } from '../api/types';

/** Lỗi luôn có mã + thông điệp dễ hiểu (spec mục 5). */
export function errorText(t: TFunction, err: unknown): string {
  if (err instanceof EngineError) return `${t(`errors.${err.code}`, { detail: err.message })} [${err.code}]`;
  return `${t('errors.UNKNOWN')} [UNKNOWN]`;
}
