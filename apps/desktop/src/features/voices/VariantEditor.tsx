// Một biến thể cảm xúc: chọn cảm xúc gợi ý (hoặc tự đặt tên) + đoạn ref đọc với cảm xúc đó + lời thoại.
import { useTranslation } from 'react-i18next';

import type { VoiceLang } from '../../api/types';
import { RefClipInput, type RefClip } from '../../components/RefClipInput';
import { TextInput, selCls } from '../../components/ui';

export const EMOTIONS = ['happy', 'angry', 'fearful', 'anxious', 'menacing', 'sad', 'calm', 'whisper'] as const;

export interface VariantDraft {
  key: string;
  emotion: string | null;
  name: string;
  clip: RefClip | null;
  transcript: string;
}

export const newDraft = (): VariantDraft => ({ key: Math.random().toString(36).slice(2), emotion: null, name: '', clip: null, transcript: '' });

export const draftReady = (d: VariantDraft) => !!(d.name.trim() && d.clip?.analysis && d.transcript.trim());

/** Tên hiển thị của biến thể: tên người dùng đặt; cảm xúc gợi ý thì dịch theo ngôn ngữ UI. */
export function variantLabel(t: (k: string) => string, v: { name: string; emotion: string | null }) {
  return v.name || (v.emotion ? t(`emotion.${v.emotion}`) : '');
}

export function VariantEditor({ draft, onChange, language }: { draft: VariantDraft; onChange: (d: VariantDraft) => void; language: VoiceLang }) {
  const { t } = useTranslation();
  const set = (patch: Partial<VariantDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] tracking-label text-mute uppercase">{t('variants.emotion')}</span>
        <div className="flex flex-wrap border border-line3">
          {EMOTIONS.map((e) => (
            <button key={e} type="button" aria-pressed={draft.emotion === e}
              onClick={() => set({ emotion: e, name: !draft.name || draft.name === (draft.emotion ? t(`emotion.${draft.emotion}`) : '') ? t(`emotion.${e}`) : draft.name })}
              className={`border-0 border-r border-line2 last:border-r-0 px-3 py-2 cursor-pointer min-h-[38px] text-[13px] font-semibold ${selCls(draft.emotion === e)}`}>
              {t(`emotion.${e}`)}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-mute">{t('variants.emotionHint')}</span>
      </div>
      <TextInput id={`${draft.key}-name`} label={t('variants.name')} value={draft.name} onChange={(name) => set({ name })} placeholder={t('variants.namePlaceholder')} />
      <RefClipInput id={draft.key} language={language} clip={draft.clip} onClip={(clip) => set({ clip })}
        transcript={draft.transcript} onTranscript={(transcript) => set({ transcript })}
        caption={t('variants.clipCaption')} dropText={t('variants.clipDrop')} />
    </div>
  );
}
