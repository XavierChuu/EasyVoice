import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import { EngineError, type EngineErrorCode, type TtsSentence } from '../../api/types';
import { Alert, Box, Btn, Icon, Label, OptionList, PageHead, Progress, Range, Segmented } from '../../components/ui';
import { Waveform, type WaveMarker } from '../../components/Waveform';
import { errorText } from '../../lib/errors';
import { platform } from '../../lib/platform';
import { buildParts } from '../../lib/segments';
import { EMPTY_FILTER, matchVoice, tagLabels } from '../../lib/voiceTags';
import { looksVietnamese, pad2, splitSentences } from '../../lib/text';
import { canSts, canTts, useEngine } from '../../stores/engine';
import { usePlayer } from '../../stores/player';
import { useSettings } from '../../stores/settings';
import { useTts } from '../../stores/tts';
import { useUi } from '../../stores/ui';
import { variantLabel } from '../voices/VariantEditor';
import { DictionaryModal } from './DictionaryModal';
import { SegmentedText, voiceColor } from './SegmentedText';

const outBtn = 'bg-transparent text-fg border border-line3 -ml-px first:ml-0 px-3 py-2 cursor-pointer min-h-[36px] font-mono text-[11px] hover:border-fg';

export function TtsPage() {
  const { t } = useTranslation();
  const s = useTts();
  const voices = useEngine((x) => x.voices);
  const jobs = useEngine((x) => x.jobs);
  const rt = useEngine((x) => x.rt);
  const models = useEngine((x) => x.system?.models);
  const { pauseMs, dict, ttsFormat, set: setSettings } = useSettings();
  const { setNotice, toast } = useUi();
  const player = usePlayer();
  const [advanced, setAdvanced] = useState(false);
  const [dictOpen, setDictOpen] = useState(false);
  const [voiceQuery, setVoiceQuery] = useState('');
  const uiLang = useSettings((x) => x.lang);

  useEffect(() => {
    if (!s.text) s.set({ text: t('tts.sample') });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ttsVoices = voices.filter(canTts);
  const profile = ttsVoices.find((v) => v.id === s.profileId) ?? ttsVoices[0];
  const variant = profile?.variants.find((v) => v.id === s.variantId) ?? null;
  const pickable = ttsVoices.filter((v) => !v.trainJobId);
  const listed = ttsVoices.filter((v) => matchVoice(v, EMPTY_FILTER, voiceQuery, (p) => {
    const tg = tagLabels(t, p, uiLang);
    return [p.name, t(`lang.${p.language}`), tg.gender, tg.country, tg.region, ...p.variants.map((x) => variantLabel(t, x))];
  }));
  // Bỏ các đoạn gán giọng đã bị xóa (giọng hoặc biến thể không còn).
  const segments = s.segments.filter((g) => {
    const v = voices.find((x) => x.id === g.profileId);
    return !!v && canTts(v) && (!g.variantId || v.variants.some((x) => x.id === g.variantId));
  });
  const voiceName = (profileId: string | null | undefined, variantId: string | null | undefined) => {
    const v = voices.find((x) => x.id === profileId);
    const vr = v?.variants.find((x) => x.id === variantId);
    return v ? `${v.name}${vr ? ` · ${variantLabel(t, vr)}` : ''}` : '?';
  };
  const chainAvail = !!profile && canSts(profile);
  const mode = chainAvail ? s.mode : 'direct';
  const job = s.jobId ? jobs[s.jobId] : undefined;
  const sentences = useMemo(() => splitSentences(s.text), [s.text]);
  const norm = useMemo(() => engine().normalizePreview(s.text, profile?.language ?? 'vi', dict), [s.text, profile?.language, dict]);

  // Model TTS khai báo ngôn ngữ đọc được (models.manifest.json) → cảnh báo trước khi đọc ngôn ngữ ngoài danh sách.
  const ttsModels = (models ?? []).filter((m) => m.group === 'tts' && m.languages);
  const installedTts = ttsModels.filter((m) => m.installed);
  const textLang = looksVietnamese(s.text) ? 'vi' : profile?.language === 'vi' ? 'vi' : 'en';
  const langUnsupported = installedTts.length > 0 && !installedTts.some((m) => m.languages!.includes(textLang));
  const langModel = ttsModels.find((m) => !m.installed && m.languages!.includes(textLang));
  const langMismatch = !!profile && (profile.language === 'vi' || profile.language === 'en') && profile.language !== textLang;

  const running = job?.status === 'running' || job?.status === 'queued';
  const failed = job?.status === 'failed';
  const rows: TtsSentence[] = job?.sentences ?? [];
  const total = rows.length;
  const done = rows.filter((r) => r.status === 'done').length;
  const complete = !!job && done === total && !running;

  const start = async () => {
    if (running && job) return void engine().cancelJob(job.id);
    if (!profile) return;
    try {
      player.stop();
      const variantId = variant?.id ?? null;
      const parts = segments.length ? buildParts(s.text, segments, profile.id, variantId) : undefined;
      const jobId = await engine().startTts({ profileId: profile.id, variantId, parts, text: s.text, mode, speed: s.speed, seed: s.seed, pauseMs, dict });
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
    toast(t('tts.exported', { fmt: fmt.toUpperCase() }), path || undefined);
  };
  const openTxt = async () => {
    const [ref] = await platform.pickFiles({ title: t('tts.openTxt'), filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (ref) onText(await platform.readText(ref));
  };
  const onText = (text: string, segs = text === s.text ? segments : []) => {
    if (text !== s.text) {
      if (running && job) void engine().cancelJob(job.id);
      player.stop();
      s.set({ text, segments: segs, jobId: null });
    } else s.set({ segments: segs });
  };

  // Waveform thật: nạp lại audio ghép của các câu đã xong mỗi khi có thêm câu (hoặc render lại một câu).
  const [waveSrc, setWaveSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!job || done === 0) return void setWaveSrc(null);
    let live = true;
    engine().ttsAudio(job.id).then((src) => live && setWaveSrc(src.url ?? null)).catch(() => live && setWaveSrc(null));
    return () => { live = false; };
  }, [job?.id, done]); // eslint-disable-line react-hooks/exhaustive-deps
  const markers = useMemo<WaveMarker[]>(() => {
    const out: WaveMarker[] = [];
    let at = 0;
    for (const r of rows) {
      if (r.status !== 'done' || r.durationSec == null) break;
      if (r.index > 0) out.push({ at, label: pad2(r.index + 1) });
      at += r.durationSec + pauseMs / 1000;
    }
    return out;
  }, [rows, pauseMs]);
  const playingAll = player.key === `tts:${job?.id}`;

  let progressText = '';
  if (job?.status === 'queued') progressText = job.waitingFor ? t('tts.queuedFor', { name: job.waitingFor }) : t('tts.queued');
  else if (job?.status === 'running') progressText = `${t('tts.rendering')} ${pad2(Math.min(done + 1, total))}/${pad2(total)}`;
  else if (failed) progressText = `${t('tts.failedAt')} ${pad2(done)}/${pad2(total)}`;
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
          <SegmentedText id="ttsText" text={s.text} segments={segments} voices={pickable} onChange={onText}
            labelOf={(g) => {
              const v = voices.find((x) => x.id === g.profileId);
              const vr = v?.variants.find((x) => x.id === g.variantId);
              return { voice: v?.name ?? '?', variant: vr ? variantLabel(t, vr) : t('variants.standard') };
            }} />
          <div className="border-t border-line px-3.5 py-2 flex flex-col gap-1.5">
            <span className="flex justify-between gap-3 font-mono text-[11px] text-mute tracking-[.06em]">
              <span>{t('tts.segments.title')} · {pad2(segments.length)}</span>
              {segments.length > 0 && (
                <button type="button" onClick={() => onText(s.text, [])} className="bg-transparent border-0 p-0 text-acc cursor-pointer font-mono text-[11px] hover:text-acc2">
                  [{t('tts.segments.clearAll')}]
                </button>
              )}
            </span>
            {segments.length === 0 && <span className="text-[12px] text-mute">{t('tts.picker.hint')}</span>}
            {segments.map((g) => (
              <div key={g.id} className="flex items-center gap-2.5 text-[13px]">
                <span className="w-2.5 h-2.5 shrink-0" style={{ background: voiceColor(g.profileId, g.variantId) }} />
                <span className="font-mono text-[11px] whitespace-nowrap">{voiceName(g.profileId, g.variantId)}</span>
                <span className="text-mute truncate flex-1 min-w-0">“{s.text.slice(g.start, g.end).replace(/\s+/g, ' ')}”</span>
                <button type="button" aria-label={t('tts.picker.clear')} onClick={() => onText(s.text, segments.filter((x) => x.id !== g.id))}
                  className="bg-transparent border-0 text-mute hover:text-acc cursor-pointer w-7 h-7">×</button>
              </div>
            ))}
          </div>
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
              <span className="flex justify-between gap-2 items-baseline">
                <Label>{t('tts.defaultVoice')}</Label>
                {profile && <span className="font-mono text-[11px] text-acc truncate">{profile.name}</span>}
              </span>
              {ttsVoices.length ? (
                <>
                  <label className="flex items-center gap-2 border border-line3 px-2.5 focus-within:border-fg">
                    <Icon d="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.6-4.6" size={14} className="text-mute shrink-0" />
                    <input type="search" value={voiceQuery} onChange={(e) => setVoiceQuery(e.target.value)} placeholder={t('tts.voiceSearch')}
                      aria-label={t('tts.voiceSearch')} className="no-ring flex-1 min-w-0 bg-transparent border-0 py-2 text-fg text-[14px] placeholder:text-dim" />
                  </label>
                  <div className="max-h-[264px] overflow-auto">
                    {listed.length ? (
                      <OptionList value={profile?.id} onChange={(id) => s.set({ profileId: id, variantId: null })} options={listed.map((v) => ({
                        id: v.id, name: v.name, tag: v.trainJobId ? 'TRAINING' : canSts(v) ? 'TTS+RVC' : 'TTS',
                      }))} />
                    ) : (
                      <span className="block border border-line px-3 py-2.5 text-mute text-[13px]">{t('tts.picker.none')}</span>
                    )}
                  </div>
                  <span className="text-[12px] text-mute">{t('tts.defaultVoiceHint')}</span>
                </>
              ) : (
                <span className="text-mute text-[13px]">{t('tts.noVoices')}</span>
              )}
            </div>
            {profile && profile.variants.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label>{t('variants.section')}</Label>
                <Segmented value={variant?.id ?? ''} onChange={(id) => s.set({ variantId: id || null })} options={[
                  { id: '', label: t('variants.standard') },
                  ...profile.variants.map((v) => ({ id: v.id, label: variantLabel(t, v) })),
                ]} />
              </div>
            )}
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

      {(langUnsupported || langMismatch) && (
        <div className="flex flex-col gap-2">
          {langUnsupported && (
            <Alert title={t('tts.langUnsupported.title', { lang: t(`lang.${textLang}`) })}>
              {t('tts.langUnsupported.body', { models: installedTts.map((m) => m.name).join(', ') })}
              {langModel && ` ${t('tts.langUnsupported.download', { name: langModel.name })}`}
            </Alert>
          )}
          {langMismatch && profile && (
            <Alert tone="line" title={t('tts.langMismatch.title')}>
              {t('tts.langMismatch.body', { text: t(`lang.${textLang}`), voice: t(`lang.${profile.language}`) })}
            </Alert>
          )}
        </div>
      )}

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
          {failed && (
            <div className="px-3.5 py-3 border-b border-line">
              <Alert title={t('tts.failedTitle')} action={
                <Btn variant="ghost" className="!min-h-[36px] !py-1 font-mono !text-[11px]" onClick={() => void start()}>↻ {t('tts.retry')}</Btn>
              }>
                {errorText(t, new EngineError((job.error ?? 'UNKNOWN') as EngineErrorCode, job.errorDetail ?? ''))}
              </Alert>
            </div>
          )}
          <div className="border-b border-line">
            <Waveform source={waveSrc} height={96} markers={markers} label={t('tts.output')}
              position={playingAll ? player.position : undefined}
              placeholder={running ? `${t('tts.rendering')}…` : undefined}
              onSeek={(f) => {
                if (playingAll) player.seek(f);
                else void engine().ttsAudio(job.id).then((src) => player.play(`tts:${job.id}`, src, f));
              }} />
            {running && <Progress value={job.progress} />}
          </div>
          <div className="flex flex-col">
            {rows.map((r, i) => {
              const { st, col } = statusOf(r);
              const key = `tts:${job.id}:${i}`;
              return (
                <div key={i} className="flex gap-3.5 items-center px-3.5 py-2.5 border-b border-line2 last:border-b-0">
                  <span className="w-7 font-mono text-mute text-[11px]">{pad2(i + 1)}</span>
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span>{r.text}</span>
                    {r.profileId && (
                      <span className="font-mono text-[10px] flex items-center gap-1.5" style={{ color: voiceColor(r.profileId, r.variantId) }}>
                        ◆ {voiceName(r.profileId, r.variantId)}
                      </span>
                    )}
                  </span>
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
