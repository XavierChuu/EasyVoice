// Chọn / thu một đoạn ref + lời thoại (dùng chung cho tạo giọng nhanh và tạo biến thể cảm xúc).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../api/engine';
import type { FileRef, RefAnalysis, VoiceLang } from '../api/types';
import { Recorder } from '../features/voices/Recorder';
import { errorText } from '../lib/errors';
import { AUDIO_FILTER, platform } from '../lib/platform';
import { usePlayer } from '../stores/player';
import { useUi } from '../stores/ui';
import { Alert, Btn, DropZone, Label } from './ui';
import { Waveform } from './Waveform';

export interface RefClip {
  ref: FileRef;
  analysis: RefAnalysis | null;
}

export const filesToRefs = (files: File[]): FileRef[] => files.map((f) => ({ path: f.name, name: f.name, size: f.size, file: f }));

export function RefClipInput({ id, language, clip, onClip, transcript, onTranscript, caption, dropText }: {
  /** Khóa duy nhất trong trang (id textarea, khóa player). */
  id: string;
  language: VoiceLang;
  clip: RefClip | null;
  onClip: (c: RefClip | null) => void;
  transcript: string;
  onTranscript: (t: string) => void;
  caption?: string;
  dropText?: string;
}) {
  const { t } = useTranslation();
  const setNotice = useUi((s) => s.setNotice);
  const player = usePlayer();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState('');
  const playKey = `ref:${id}`;

  const setFile = async (ref: FileRef) => {
    onClip({ ref, analysis: null });
    try {
      onClip({ ref, analysis: await engine().analyzeRef(ref) });
    } catch (err) {
      onClip(null);
      setNotice(errorText(t, err));
    }
  };
  const pick = async () => {
    const [ref] = await platform.pickFiles({ title: t('wizard.quick.choose'), filters: [AUDIO_FILTER] });
    if (ref) await setFile(ref);
  };
  const autoTranscript = async () => {
    if (!clip) return;
    setTranscribing(true);
    setTranscribeError('');
    try {
      onTranscript(await engine().transcribe(clip.ref, language));
    } catch (err) {
      setTranscribeError(errorText(t, err));
    } finally {
      setTranscribing(false);
    }
  };
  const play = (at?: number) => {
    if (!clip?.ref.file) return;
    player.play(playKey, { durationSec: clip.analysis?.durationSec ?? 8, url: URL.createObjectURL(clip.ref.file) }, at);
  };

  const a = clip?.analysis;
  return (
    <div className="flex flex-col gap-[18px]">
      {!clip ? (
        <DropZone caption={caption ?? t('wizard.quick.caption')} text={dropText ?? t('wizard.quick.drop')}
          onFiles={(f) => f[0] && void setFile(filesToRefs(f)[0])}>
          <Btn variant="outline" onClick={() => void pick()}>{t('wizard.quick.choose')}</Btn>
          <Btn variant="ghost" onClick={() => setRecording(true)}>● {t('wizard.quick.record')}</Btn>
        </DropZone>
      ) : (
        <div className="border border-line">
          <div className="flex justify-between items-center flex-wrap gap-2 px-3 py-2 border-b border-line font-mono text-[12px]">
            <span>{clip.ref.name} {a && <span className="text-mute">· {a.durationSec.toFixed(2)}s · {Math.round(a.sampleRate / 1000)}kHz · {a.channels === 1 ? 'mono' : 'stereo'}</span>}</span>
            <span className="flex gap-3">
              {clip.ref.file && (
                <Btn variant="link" onClick={() => (player.key === playKey ? player.stop() : play())}>
                  [{player.key === playKey ? `■ ${t('common.stop')}` : `▶ ${t('recorder.listen')}`}]
                </Btn>
              )}
              <Btn variant="link" onClick={() => { player.stop(); onClip(null); onTranscript(''); }}>[{t('common.replace')}]</Btn>
            </span>
          </div>
          <Waveform source={clip.ref.file} height={88} label={clip.ref.name} placeholder={t('wizard.noPreview')}
            position={player.key === playKey ? player.position : undefined}
            onSeek={clip.ref.file ? (f) => (player.key === playKey ? player.seek(f) : play(f)) : undefined} />
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
          <Label htmlFor={`${id}-transcript`}>{t('wizard.transcript')}</Label>
          <button type="button" onClick={() => void autoTranscript()} disabled={!clip || transcribing}
            className="bg-transparent border border-line3 text-fg px-3 py-1.5 cursor-pointer font-mono text-[11px] min-h-[36px] hover:border-fg">
            {transcribing ? t('wizard.transcribing') : 'AUTO · WHISPER'}
          </button>
        </span>
        <textarea id={`${id}-transcript`} value={transcript} onChange={(e) => onTranscript(e.target.value)} rows={2}
          placeholder={t('wizard.transcriptPlaceholder')}
          className="bg-bg border border-line3 p-3 text-fg text-[15px] resize-y rounded-none placeholder:text-dim" />
        <span className="text-[12px] text-mute">{t('wizard.transcriptHint')}</span>
        {transcribeError && <span className="text-[12px] text-acc">{transcribeError}</span>}
      </div>
      {recording && <Recorder onClose={() => setRecording(false)} onDone={(ref) => { setRecording(false); void setFile(ref); }} />}
    </div>
  );
}
