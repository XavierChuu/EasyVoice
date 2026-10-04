import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { DatasetFile, FileRef, RefAnalysis, TrainPreset, VoiceLang } from '../../api/types';
import { Alert, Bars, Btn, Check, DropZone, Label, Panel, Segmented, TextInput, selCls } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { AUDIO_FILTER, MEDIA_FILTER, platform } from '../../lib/platform';
import { formatDuration } from '../../lib/text';
import { useSettings } from '../../stores/settings';
import { usePlayer } from '../../stores/player';
import { useUi } from '../../stores/ui';
import { Recorder } from './Recorder';

const MIN_MIN = 8; // spec 3.1: cảnh báo nếu dưới 8 phút
const REC_MIN = 10;

const toRefs = (files: File[]): FileRef[] => files.map((f) => ({ path: f.name, name: f.name, size: f.size, file: f }));

export function NewVoiceWizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const uiLang = useSettings((s) => s.lang);
  const toast = useUi((s) => s.toast);
  const setNotice = useUi((s) => s.setNotice);
  const player = usePlayer();
  const [mode, setMode] = useState<'quick' | 'hq'>('quick');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<VoiceLang>(uiLang);
  const [quick, setQuick] = useState<{ ref: FileRef; analysis: RefAnalysis | null } | null>(null);
  const [transcript, setTranscript] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState('');
  const [dataset, setDataset] = useState<DatasetFile[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [separate, setSeparate] = useState(true);
  const [preset, setPreset] = useState<TrainPreset>('balanced');
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isQuick = mode === 'quick';
  const totalSec = dataset.reduce((a, d) => a + d.durationSec, 0);

  const setQuickFile = async (ref: FileRef) => {
    setQuick({ ref, analysis: null });
    try {
      setQuick({ ref, analysis: await engine().analyzeRef(ref) });
    } catch (err) {
      setQuick(null);
      setNotice(errorText(t, err));
    }
  };
  const pickQuick = async () => {
    const [ref] = await platform.pickFiles({ title: t('wizard.quick.choose'), filters: [AUDIO_FILTER] });
    if (ref) await setQuickFile(ref);
  };
  const addDataset = async (refs: FileRef[]) => {
    if (!refs.length) return;
    setAnalyzing(true);
    const added = await engine().analyzeDataset(refs);
    setDataset((d) => [...d, ...added.filter((a) => !d.some((x) => x.ref.path === a.ref.path))]);
    setAnalyzing(false);
  };
  const pickDataset = async () => addDataset(await platform.pickFiles({ title: t('wizard.hq.choose'), multiple: true, filters: [MEDIA_FILTER] }));
  const autoTranscript = async () => {
    if (!quick) return;
    setTranscribing(true);
    setTranscribeError('');
    try {
      setTranscript(await engine().transcribe(quick.ref, language));
    } catch (err) {
      setTranscribeError(errorText(t, err));
    } finally {
      setTranscribing(false);
    }
  };

  let hint: string;
  if (!name.trim()) hint = t('wizard.hint.name');
  else if (isQuick && !quick) hint = t('wizard.hint.file');
  else if (isQuick && !transcript.trim()) hint = t('wizard.hint.transcript');
  else if (!isQuick && !dataset.length) hint = t('wizard.hint.files');
  else if (!isQuick && totalSec < MIN_MIN * 60) hint = t('wizard.hint.tooShort', { min: MIN_MIN });
  else if (!consent) hint = t('wizard.hint.consent');
  else hint = isQuick ? t('wizard.hint.ready') : t('wizard.hint.background');
  const disabled = submitting || !(name.trim() && consent && (isQuick ? quick && transcript.trim() : dataset.length && totalSec >= MIN_MIN * 60));

  const submit = async () => {
    setSubmitting(true);
    try {
      if (isQuick && quick) {
        await engine().createQuickVoice({ name: name.trim(), language, file: quick.ref, transcript: transcript.trim(), consent: true });
        toast(t('wizard.created', { name: name.trim() }));
      } else {
        await engine().startTraining({ name: name.trim(), language, files: dataset.map((d) => d.ref), separate, preset, consent: true });
        toast(t('wizard.trainingStarted', { name: name.trim() }));
      }
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
  const a = quick?.analysis;

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
            <Segmented options={[{ id: 'vi', label: t('lang.vi') }, { id: 'en', label: t('lang.en') }]} value={language === 'en' ? 'en' : 'vi'} onChange={setLanguage} />
          </div>
        </div>

        {isQuick ? (
          <div className="flex flex-col gap-[18px]">
            {!quick ? (
              <DropZone caption={t('wizard.quick.caption')} text={t('wizard.quick.drop')} onFiles={(f) => f[0] && void setQuickFile(toRefs(f)[0])}>
                <Btn variant="outline" onClick={() => void pickQuick()}>{t('wizard.quick.choose')}</Btn>
                <Btn variant="ghost" onClick={() => setRecording(true)}>● {t('wizard.quick.record')}</Btn>
              </DropZone>
            ) : (
              <div className="border border-line">
                <div className="flex justify-between items-center flex-wrap gap-2 px-3 py-2 border-b border-line font-mono text-[12px]">
                  <span>{quick.ref.name} {a && <span className="text-mute">· {a.durationSec.toFixed(2)}s · {Math.round(a.sampleRate / 1000)}kHz · {a.channels === 1 ? 'mono' : 'stereo'}</span>}</span>
                  <span className="flex gap-3">
                    {quick.ref.file && (
                      <Btn variant="link" onClick={() => (player.key === 'wizard-ref' ? player.stop()
                        : player.play('wizard-ref', { durationSec: a?.durationSec ?? 8, url: URL.createObjectURL(quick.ref.file!) }))}>
                        [{player.key === 'wizard-ref' ? `■ ${t('common.stop')}` : `▶ ${t('recorder.listen')}`}]
                      </Btn>
                    )}
                    <Btn variant="link" onClick={() => { player.stop(); setQuick(null); setTranscript(''); }}>[{t('common.replace')}]</Btn>
                  </span>
                </div>
                <Bars seed={0.9} n={60} height={56} playhead={player.key === 'wizard-ref' ? player.position : undefined} />
                <div className="flex flex-wrap gap-x-5 gap-y-2 px-3 py-2.5 border-t border-line font-mono text-[11px] text-mute">
                  {!a && <span className="text-acc">{t('wizard.quick.analyzing')}</span>}
                  {a?.checks.map((c) => (
                    <span key={c.key}><span className={c.ok ? 'text-acc' : 'text-fg'}>{c.ok ? 'OK' : '!!'}</span> {t(`wizard.check.${c.key}`)}</span>
                  ))}
                </div>
              </div>
            )}
            {a?.warnings.map((w) => <Alert key={w} title={t(`wizard.warn.${w}.title`)}>{t(`wizard.warn.${w}.body`)}</Alert>)}
            <div className="flex flex-col gap-1.5">
              <span className="flex justify-between flex-wrap gap-2 items-center">
                <Label htmlFor="transcript">{t('wizard.transcript')}</Label>
                <button type="button" onClick={() => void autoTranscript()} disabled={!quick || transcribing}
                  className="bg-transparent border border-line3 text-fg px-3 py-1.5 cursor-pointer font-mono text-[11px] min-h-[36px] hover:border-fg">
                  {transcribing ? t('wizard.transcribing') : 'AUTO · WHISPER'}
                </button>
              </span>
              <textarea id="transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={2} placeholder={t('wizard.transcriptPlaceholder')}
                className="bg-bg border border-line3 p-3 text-fg text-[15px] resize-y rounded-none placeholder:text-dim" />
              <span className="text-[12px] text-mute">{t('wizard.transcriptHint')}</span>
              {transcribeError && <span className="text-[12px] text-acc">{transcribeError}</span>}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-[18px]">
            {!dataset.length ? (
              <DropZone caption={t('wizard.hq.caption')} text={t('wizard.hq.drop')} onFiles={(f) => void addDataset(toRefs(f))}>
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

        <Check id="consent" checked={consent} onChange={setConsent} boxed>{t('wizard.consent')}</Check>

        <div className="flex justify-end items-center gap-4 flex-wrap">
          <span className="font-mono text-[11px] text-mute">&gt; {hint}</span>
          <Btn variant="primary" onClick={() => void submit()} disabled={!!disabled}>
            {submitting ? t('common.working') : isQuick ? t('wizard.create') : t('wizard.startTraining')}
          </Btn>
        </div>
      </div>
      {recording && <Recorder onClose={() => setRecording(false)} onDone={(ref) => { setRecording(false); void setQuickFile(ref); }} />}
    </Panel>
  );
}
