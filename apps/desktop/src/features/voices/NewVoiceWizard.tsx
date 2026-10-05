import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { DatasetFile, FileRef, TrainPreset, VoiceLang, VoiceTags } from '../../api/types';
import { filesToRefs, RefClipInput, type RefClip } from '../../components/RefClipInput';
import { Alert, Btn, Check, DropZone, Label, Panel, Segmented, TextInput, selCls } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { MEDIA_FILTER, platform } from '../../lib/platform';
import { formatDuration, pad2 } from '../../lib/text';
import { defaultCountry } from '../../lib/voiceTags';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { TagFields } from './TagFields';
import { draftReady, newDraft, VariantEditor, type VariantDraft } from './VariantEditor';

const MIN_MIN = 8; // spec 3.1: cảnh báo nếu dưới 8 phút
const REC_MIN = 10;

export function NewVoiceWizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const uiLang = useSettings((s) => s.lang);
  const toast = useUi((s) => s.toast);
  const setNotice = useUi((s) => s.setNotice);
  const [mode, setMode] = useState<'quick' | 'hq'>('quick');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<VoiceLang>(uiLang);
  const [quick, setQuick] = useState<RefClip | null>(null);
  const [tags, setTags] = useState<VoiceTags>({ gender: null, country: defaultCountry(uiLang) || null, region: null });
  const [transcript, setTranscript] = useState('');
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [dataset, setDataset] = useState<DatasetFile[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [separate, setSeparate] = useState(true);
  const [preset, setPreset] = useState<TrainPreset>('balanced');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isQuick = mode === 'quick';
  const totalSec = dataset.reduce((a, d) => a + d.durationSec, 0);

  const addDataset = async (refs: FileRef[]) => {
    if (!refs.length) return;
    setAnalyzing(true);
    const added = await engine().analyzeDataset(refs);
    setDataset((d) => [...d, ...added.filter((a) => !d.some((x) => x.ref.path === a.ref.path))]);
    setAnalyzing(false);
  };
  const pickDataset = async () => addDataset(await platform.pickFiles({ title: t('wizard.hq.choose'), multiple: true, filters: [MEDIA_FILTER] }));

  let hint: string;
  if (!name.trim()) hint = t('wizard.hint.name');
  else if (isQuick && !quick) hint = t('wizard.hint.file');
  else if (isQuick && !transcript.trim()) hint = t('wizard.hint.transcript');
  else if (!isQuick && !dataset.length) hint = t('wizard.hint.files');
  else if (!isQuick && totalSec < MIN_MIN * 60) hint = t('wizard.hint.tooShort', { min: MIN_MIN });
  else if (variants.some((v) => !draftReady(v))) hint = t('variants.hint.incomplete');
  else if (!consent) hint = t('wizard.hint.consent');
  else hint = isQuick ? t('wizard.hint.ready') : t('wizard.hint.background');
  const disabled = submitting || variants.some((v) => !draftReady(v))
    || !(name.trim() && consent && (isQuick ? quick && transcript.trim() : dataset.length && totalSec >= MIN_MIN * 60));

  const submit = async () => {
    setSubmitting(true);
    try {
      const profile = isQuick && quick
        ? await engine().createQuickVoice({ name: name.trim(), language, file: quick.ref, transcript: transcript.trim(), consent: true, tags })
        : await engine().startTraining({ name: name.trim(), language, files: dataset.map((d) => d.ref), separate, preset, consent: true });
      // Biến thể tạo sau giọng chuẩn; một biến thể lỗi không làm mất giọng đã tạo.
      const failed: string[] = [];
      for (const v of variants) {
        try {
          await engine().addVariant(profile.id, { name: v.name.trim(), emotion: v.emotion, file: v.clip!.ref, transcript: v.transcript.trim() });
        } catch (err) {
          failed.push(`${v.name.trim()}: ${errorText(t, err)}`);
        }
      }
      toast(isQuick ? t('wizard.created', { name: name.trim() }) : t('wizard.trainingStarted', { name: name.trim() }));
      if (failed.length) setNotice(t('variants.someFailed', { list: failed.join(' · ') }));
      onClose();
    } catch (err) {
      setNotice(errorText(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  const modeCards = [
    { id: 'quick' as const, code: 'A · ZERO-SHOT', title: t('wizard.quick.title'), desc: t('wizard.quick.desc'), meta: t('wizard.quick.meta') },
    { id: 'hq' as const, code: 'B · FINE-TUNE', title: t('wizard.hq.title'), desc: t('wizard.hq.desc'), meta: t('wizard.hq.meta') },
  ];

  return (
    <Panel title="NEW_PROFILE" label={t('wizard.aria')} onClose={onClose}>
      <div className="p-5 flex flex-col gap-[22px]">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] border border-line">
          {modeCards.map((m) => (
            <button key={m.id} type="button" onClick={() => setMode(m.id)} aria-pressed={mode === m.id}
              className={`text-left border-0 p-[18px] cursor-pointer flex flex-col gap-1.5 ${selCls(mode === m.id)}`}>
              <span className="font-mono text-[11px] tracking-label opacity-70">{m.code}</span>
              <span className="font-bold text-[18px]">{m.title}</span>
              <span>{m.desc}</span>
              <span className="font-mono text-[11px] opacity-70">{m.meta}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4 items-end">
          <TextInput label={t('wizard.name')} value={name} onChange={setName} placeholder={t('wizard.namePlaceholder')} autoFocus />
          <div className="flex flex-col gap-1.5">
            <Label>{t('wizard.language')}</Label>
            <Segmented options={[{ id: 'vi', label: t('lang.vi') }, { id: 'en', label: t('lang.en') }]} value={language === 'en' ? 'en' : 'vi'}
              onChange={(l) => {
                setLanguage(l);
                // Quốc gia đang là mặc định của ngôn ngữ cũ (chưa tự chọn) thì đổi theo ngôn ngữ mới.
                if (!tags.country || tags.country === defaultCountry(language)) setTags({ ...tags, country: defaultCountry(l) || null, region: null });
              }} />
          </div>
        </div>
        <TagFields id="wizard" value={tags} onChange={setTags} />

        {isQuick ? (
          <RefClipInput id="wizard" language={language} clip={quick} onClip={setQuick} transcript={transcript} onTranscript={setTranscript} />
        ) : (
          <div className="flex flex-col gap-[18px]">
            {!dataset.length ? (
              <DropZone caption={t('wizard.hq.caption')} text={t('wizard.hq.drop')} onFiles={(f) => void addDataset(filesToRefs(f))}>
                <Btn variant="outline" onClick={() => void pickDataset()} disabled={analyzing}>{analyzing ? t('wizard.quick.analyzing') : t('wizard.hq.choose')}</Btn>
              </DropZone>
            ) : (
              <div className="border border-line font-mono text-[12px]">
                <div className="flex justify-between px-3 py-2 border-b border-line text-mute text-[11px] tracking-label">
                  <span>{t('wizard.hq.file')}</span><span>{t('wizard.hq.duration')}</span>
                </div>
                {dataset.map((d) => (
                  <div key={d.ref.path} className="flex justify-between items-center px-3 py-1 border-b border-line2">
                    <span className="break-all">{d.ref.name}</span>
                    <span className="flex items-center gap-1 text-mute">
                      {formatDuration(d.durationSec)}
                      <button type="button" aria-label={t('common.remove')} onClick={() => setDataset(dataset.filter((x) => x !== d))}
                        className="bg-transparent border-0 text-mute hover:text-acc cursor-pointer w-8 h-8">×</button>
                    </span>
                  </div>
                ))}
                <div className="flex justify-between items-center px-3 py-2.5 font-bold flex-wrap gap-2">
                  <span>{t('wizard.hq.total')} {formatDuration(totalSec)}</span>
                  <span className="flex items-center gap-3">
                    <Btn variant="link" onClick={() => void pickDataset()} disabled={analyzing}>[{t('wizard.hq.add')}]</Btn>
                    <span className="text-acc">{totalSec >= REC_MIN * 60 ? 'READY' : totalSec >= MIN_MIN * 60 ? 'OK' : 'TOO SHORT'}</span>
                  </span>
                </div>
              </div>
            )}
            {dataset.length > 0 && totalSec < MIN_MIN * 60 && (
              <Alert title={t('wizard.hq.shortTitle', { min: MIN_MIN })}>{t('wizard.hq.shortBody', { have: formatDuration(totalSec) })}</Alert>
            )}
            {totalSec >= MIN_MIN * 60 && totalSec < REC_MIN * 60 && (
              <Alert tone="line" title={t('wizard.hq.okTitle')}>{t('wizard.hq.okBody')}</Alert>
            )}
            <Check id="sep" checked={separate} onChange={setSeparate}>{t('wizard.hq.separate')}</Check>
            <div className="flex flex-col gap-2">
              <Label>{t('wizard.hq.preset')}</Label>
              <Segmented value={preset} onChange={setPreset} options={(['fast', 'balanced', 'thorough'] as const).map((id) => ({
                id, label: t(`wizard.preset.${id}.title`), desc: t(`wizard.preset.${id}.desc`),
              }))} />
            </div>
          </div>
        )}

        <div className="border border-line flex flex-col">
          <div className="flex justify-between items-center gap-3 flex-wrap px-3.5 py-2 border-b border-line">
            <span className="font-mono text-[11px] tracking-[.08em] text-mute">{t('variants.section')} · {pad2(variants.length)}</span>
            <Btn variant="link" onClick={() => setVariants([...variants, newDraft()])}>[+ {t('variants.add')}]</Btn>
          </div>
          {variants.length === 0 ? (
            <p className="m-0 px-3.5 py-3 text-[13px] text-mute">{t('variants.sectionHint')}</p>
          ) : variants.map((v, i) => (
            <div key={v.key} className="p-3.5 border-b border-line2 last:border-b-0 flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <span className="font-mono text-[11px] tracking-label text-acc">{t('variants.variant')} {pad2(i + 1)}</span>
                <Btn variant="link" onClick={() => setVariants(variants.filter((x) => x.key !== v.key))}>[{t('common.remove')}]</Btn>
              </div>
              <VariantEditor draft={v} language={language} onChange={(d) => setVariants(variants.map((x) => (x.key === v.key ? d : x)))} />
            </div>
          ))}
        </div>

        <Check id="consent" checked={consent} onChange={setConsent} boxed>{t('wizard.consent')}</Check>

        <div className="flex justify-end items-center gap-4 flex-wrap">
          <span className="font-mono text-[11px] text-mute">&gt; {hint}</span>
          <Btn variant="primary" onClick={() => void submit()} disabled={!!disabled}>
            {submitting ? t('common.working') : isQuick ? t('wizard.create') : t('wizard.startTraining')}
          </Btn>
        </div>
      </div>
    </Panel>
  );
}
