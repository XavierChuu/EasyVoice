import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { TtsSentence } from '../../api/types';
import { Bars, Box, Btn, Label, OptionList, PageHead, Range, Segmented } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { platform } from '../../lib/platform';
import { pad2, splitSentences } from '../../lib/text';
import { canSts, canTts, useEngine } from '../../stores/engine';
import { usePlayer } from '../../stores/player';
import { useSettings } from '../../stores/settings';
import { useTts } from '../../stores/tts';
import { useUi } from '../../stores/ui';
import { DictionaryModal } from './DictionaryModal';

const outBtn = 'bg-transparent text-fg border border-line3 -ml-px first:ml-0 px-3 py-2 cursor-pointer min-h-[36px] font-mono text-[11px] hover:border-fg';

export function TtsPage() {
  const { t } = useTranslation();
  const s = useTts();
  const voices = useEngine((x) => x.voices);
  const jobs = useEngine((x) => x.jobs);
  const rt = useEngine((x) => x.rt);
  const { pauseMs, dict, ttsFormat, set: setSettings } = useSettings();
  const { setNotice, toast } = useUi();
  const player = usePlayer();
  const [advanced, setAdvanced] = useState(false);
  const [dictOpen, setDictOpen] = useState(false);

  useEffect(() => {
    if (!s.text) s.set({ text: t('tts.sample') });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ttsVoices = voices.filter(canTts);
  const profile = ttsVoices.find((v) => v.id === s.profileId) ?? ttsVoices[0];
  const chainAvail = !!profile && canSts(profile);
  const mode = chainAvail ? s.mode : 'direct';
  const job = s.jobId ? jobs[s.jobId] : undefined;
  const sentences = useMemo(() => splitSentences(s.text), [s.text]);
  const norm = useMemo(() => engine().normalizePreview(s.text, profile?.language ?? 'vi', dict), [s.text, profile?.language, dict]);

  const running = job?.status === 'running' || job?.status === 'queued';
  const rows: TtsSentence[] = job?.sentences ?? [];
  const total = rows.length;
  const done = rows.filter((r) => r.status === 'done').length;
  const complete = !!job && done === total && !running;

  const start = async () => {
    if (running && job) return void engine().cancelJob(job.id);
    if (!profile) return;
    try {
      player.stop();
      const jobId = await engine().startTts({ profileId: profile.id, text: s.text, mode, speed: s.speed, seed: s.seed, pauseMs });
      s.set({ jobId });
      setNotice('');
    } catch (err) {
      setNotice(errorText(t, err));
    }
  };
  const redo = async (i: number) => {
    if (!job) return;
    try {
      await engine().redoSentence(job.id, i);
    } catch (err) {
      setNotice(errorText(t, err));
    }
  };
  const exportAs = async (fmt: 'wav' | 'mp3' | 'flac' | 'srt') => {
    if (!job) return;
    const path = await engine().exportTts(job.id, fmt);
    if (fmt !== 'srt') setSettings({ ttsFormat: fmt });
    toast(t('tts.exported', { fmt: fmt.toUpperCase() }), path);
  };
  const openTxt = async () => {
    const [ref] = await platform.pickFiles({ title: t('tts.openTxt'), filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (ref) onText(await platform.readText(ref));
  };
  const onText = (text: string) => {
    if (running && job) void engine().cancelJob(job.id);
    player.stop();
    s.set({ text, jobId: null });
  };

  const doneDuration = rows.filter((r) => r.status === 'done').reduce((a, r) => a + (r.durationSec ?? 0) + pauseMs / 1000, 0);
  const playingAll = player.key === `tts:${job?.id}`;

  let progressText = '';
  if (job?.status === 'queued') progressText = job.waitingFor ? t('tts.queuedFor', { name: job.waitingFor }) : t('tts.queued');
  else if (job?.status === 'running') progressText = `${t('tts.rendering')} ${pad2(Math.min(done + 1, total))}/${pad2(total)}`;
  else if (complete) progressText = `${t('tts.complete')} ${pad2(total)}/${pad2(total)}`;
  else if (job) progressText = `${t('tts.stoppedAt')} ${pad2(done)}/${pad2(total)}`;

  const statusOf = (r: TtsSentence) => {
    if (r.status === 'redo') return { st: t('tts.st.redo'), col: '#FF5B14' };
    if (r.status === 'done') return { st: t('tts.st.done'), col: '#F2F2F2' };
    if (r.status === 'rendering') return { st: `${t('tts.st.render')} ${pad2(Math.floor(r.progress * 100))}%`, col: '#FF5B14' };
    return { st: t('tts.st.queued'), col: '#8F8F8F' };
  };

  return (
    <div className="flex flex-col gap-7">
      <PageHead code={t('tts.code')} title={t('tts.title')} desc={t('tts.desc')} />
      <div className="flex flex-wrap gap-4 items-stretch">
        <Box className="flex-[2_1_420px]" title={
          <span className="flex gap-3 items-center">
            <label htmlFor="ttsText">INPUT.TXT</label>
            <button type="button" onClick={() => void openTxt()} className="bg-transparent border-0 text-acc cursor-pointer font-mono text-[11px] p-0 hover:text-acc2">[{t('tts.openTxt')}]</button>
            <button type="button" onClick={() => setDictOpen(true)} className="bg-transparent border-0 text-acc cursor-pointer font-mono text-[11px] p-0 hover:text-acc2">[{t('tts.dictionary')}{dict.length ? ` · ${dict.length}` : ''}]</button>
          </span>
        } right={<span>{s.text.length} {t('tts.chars')} · {sentences.length} {t('tts.sent')}</span>}>
          <textarea id="ttsText" value={s.text} onChange={(e) => onText(e.target.value)} rows={9}
            className="bg-bg border-0 p-4 text-fg text-[16px] leading-[1.7] resize-y rounded-none" />
          {norm.length > 0 && (
            <div className="border-t border-line px-3.5 py-2.5 flex flex-col gap-1 font-mono text-[12px] flex-grow">
              <span className="text-[11px] tracking-label text-mute">{t('tts.normalization')}</span>
              {norm.map((r) => (
                <div key={r.from}><span className="text-acc">{r.from}</span><span className="text-mute"> → </span><span>{r.to}</span></div>
              ))}
            </div>
          )}
        </Box>

        <Box className="flex-[1_1_280px]" title="PARAMS">
          <div className="px-3.5 py-4 flex flex-col gap-5 flex-grow">
            <div className="flex flex-col gap-2">
              <Label>{t('tts.voice')}</Label>
              {ttsVoices.length ? (
                <OptionList value={profile?.id} onChange={(id) => s.set({ profileId: id })} options={ttsVoices.map((v) => ({
                  id: v.id, name: v.name, tag: v.trainJobId ? 'TRAINING' : canSts(v) ? 'TTS+RVC' : 'TTS',
                }))} />
              ) : (
                <span className="text-mute text-[13px]">{t('tts.noVoices')}</span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t('tts.mode')}</Label>
              <Segmented value={mode} onChange={(m) => s.set({ mode: m })} options={[
                { id: 'direct', label: t('tts.direct') },
                { id: 'chain', label: t('tts.chain'), disabled: !chainAvail },
              ]} />
              <span className="text-[12px] text-mute">{mode === 'chain' ? t('tts.hint.chain') : chainAvail ? t('tts.hint.direct') : t('tts.hint.noRvc')}</span>
            </div>
            <Range label={t('tts.speed')} valueText={`${s.speed.toFixed(2)}x`} min={0.7} max={1.3} step={0.05} value={s.speed} onChange={(v) => s.set({ speed: v })} />
            <button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}
              className="bg-transparent border-0 p-0 text-left text-mute hover:text-fg cursor-pointer font-mono text-[11px] tracking-label">
              {advanced ? '▾' : '▸'} {t('common.advanced')}
            </button>
            {advanced && (
              <div className="flex flex-col gap-5">
                <Range label={t('tts.pause')} valueText={`${pauseMs} ms`} min={0} max={1000} step={50} value={pauseMs} onChange={(v) => setSettings({ pauseMs: v })} hint={t('tts.pauseHint')} />
                <label className="flex flex-col gap-2">
                  <Label>SEED</Label>
                  <span className="flex gap-2">
                    <input type="number" value={s.seed} onChange={(e) => s.set({ seed: Number(e.target.value) || 0 })}
                      className="bg-bg border border-line3 px-3 py-2 text-fg font-mono w-full rounded-none" />
                    <Btn variant="ghost" className="!min-h-[38px] !py-1 font-mono" aria-label={t('tts.randomSeed')}
                      onClick={() => s.set({ seed: Math.floor(Math.random() * 1e6) })}>⚄</Btn>
                  </span>
                  <span className="text-[12px] text-mute">{t('tts.seedHint')}</span>
                </label>
              </div>
            )}
            <div className="flex-grow" />
            <button type="button" onClick={() => void start()} disabled={!profile || !s.text.trim() || rt.running && !running}
              className={`px-5 py-3.5 font-mono font-bold text-[13px] tracking-wide2 cursor-pointer min-h-[50px] ${running ? 'bg-transparent text-fg border border-fg' : 'bg-acc text-bg border-0 hover:bg-acc2'}`}>
              {running ? `■ ${t('common.stop').toUpperCase()}` : `▶ ${t('tts.read')}`}
            </button>
            {rt.running && !running && <span className="text-[12px] text-acc -mt-3">{t('errors.GPU_BUSY_REALTIME')}</span>}
          </div>
        </Box>
      </div>

      {job && (
        <section aria-label={t('tts.output')} className="border border-line flex flex-col">
          <div className="flex justify-between items-center flex-wrap gap-3 py-2 pr-2 pl-3.5 border-b border-line">
            <div className="flex flex-col">
              <span className="font-mono text-[12px] tracking-[.06em]">{progressText}</span>
              {engine().mode === 'mock' && <span className="font-mono text-[10px] text-mute">{t('tts.mockNote')}</span>}
            </div>
            <div className="flex flex-wrap">
              <button type="button" className={outBtn} disabled={done === 0}
                onClick={async () => (playingAll ? player.stop() : player.play(`tts:${job.id}`, await engine().ttsAudio(job.id)))}>
                {playingAll ? '■ STOP' : '▶ PLAY'}
              </button>
              {(['wav', 'mp3', 'flac', 'srt'] as const).map((f) => (
                <button key={f} type="button" className={`${outBtn} ${f === ttsFormat ? '!border-fg' : ''}`} disabled={!complete} onClick={() => void exportAs(f)}>.{f.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div className="wave-grid border-b border-line">
            <Bars seed={1.3} height={72} progress={job.progress} playhead={playingAll ? player.position * (doneDuration ? done / total : 0) : undefined} className="!px-3.5" />
          </div>
          <div className="flex flex-col">
            {rows.map((r, i) => {
              const { st, col } = statusOf(r);
              const key = `tts:${job.id}:${i}`;
              return (
                <div key={i} className="flex gap-3.5 items-center px-3.5 py-2.5 border-b border-line2 last:border-b-0">
                  <span className="w-7 font-mono text-mute text-[11px]">{pad2(i + 1)}</span>
                  <span className="flex-1 min-w-0">{r.text}</span>
                  <span className="font-mono text-[11px] whitespace-nowrap" style={{ color: col }}>{st}</span>
                  <button type="button" disabled={r.status !== 'done'} aria-label={t('tts.playSentence')}
                    onClick={async () => (player.key === key ? player.stop() : player.play(key, await engine().ttsAudio(job.id, i)))}
                    className="bg-transparent border border-line3 text-fg px-2.5 py-1.5 cursor-pointer font-mono text-[11px] min-h-[34px] hover:border-fg">
                    {player.key === key ? '■' : '▶'}
                  </button>
                  <button type="button" onClick={() => void redo(i)} disabled={r.status !== 'done' || rows.some((x) => x.status === 'redo')}
                    className="bg-transparent border border-line3 text-fg px-2.5 py-1.5 cursor-pointer font-mono text-[11px] min-h-[34px] whitespace-nowrap hover:border-fg">
                    ↻ {t('tts.redo')}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {dictOpen && <DictionaryModal onClose={() => setDictOpen(false)} />}
    </div>
  );
}
