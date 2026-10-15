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
  // Lỗi phía renderer (không qua engine): vẫn hiện thông điệp gốc, nếu không người dùng chỉ thấy "đã có lỗi".
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : err ? String(err) : '';
  return errorText(t, new EngineError('UNKNOWN', detail.slice(0, 300)));
}

/** Mã lỗi mà người dùng cần gửi file log cho nhóm phát triển → NoticeBar hiện nút mở thư mục log. */
export const NEEDS_LOG = /\[(UNKNOWN|ENGINE_RESTARTED)\]$/;
