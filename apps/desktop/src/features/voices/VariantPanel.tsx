// Tạo biến thể cảm xúc cho một giọng đã có (cùng người đọc, đọc với cảm xúc khác).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { Profile } from '../../api/types';
import { Btn, Check, Panel } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { useUi } from '../../stores/ui';
import { draftReady, newDraft, VariantEditor } from './VariantEditor';

export function VariantPanel({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast, setNotice } = useUi();
  const [draft, setDraft] = useState(newDraft);
  const [same, setSame] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  let hint: string;
  if (!draft.name.trim()) hint = t('variants.hint.name');
  else if (!draft.clip) hint = t('wizard.hint.file');
  else if (!draft.transcript.trim()) hint = t('wizard.hint.transcript');
  else if (!same) hint = t('variants.hint.same');
  else hint = t('wizard.hint.ready');

  const submit = async () => {
    if (!draft.clip) return;
    setSubmitting(true);
    try {
      await engine().addVariant(profile.id, { name: draft.name.trim(), emotion: draft.emotion, file: draft.clip.ref, transcript: draft.transcript.trim() });
      toast(t('variants.created', { name: draft.name.trim(), voice: profile.name }));
      onClose();
    } catch (err) {
      setNotice(errorText(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel title={`NEW_VARIANT · ${profile.name.toUpperCase()}`} label={t('variants.aria', { name: profile.name })} onClose={onClose}>
      <div className="p-5 flex flex-col gap-[22px]">
        <p className="m-0 text-soft">{t('variants.intro', { name: profile.name })}</p>
        <VariantEditor draft={draft} onChange={setDraft} language={profile.language} />
        <Check id="variant-same" checked={same} onChange={setSame} boxed>{t('variants.same', { name: profile.name })}</Check>
        <div className="flex justify-end items-center gap-4 flex-wrap">
          <span className="font-mono text-[11px] text-mute">&gt; {hint}</span>
          <Btn variant="primary" onClick={() => void submit()} disabled={submitting || !same || !draftReady(draft)}>
            {submitting ? t('common.working') : t('variants.create')}
          </Btn>
        </div>
      </div>
    </Panel>
  );
}
