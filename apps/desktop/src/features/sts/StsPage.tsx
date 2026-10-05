import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { AudioDevice, FileRef, Profile } from '../../api/types';
import { Alert, Box, Btn, Check, DropZone, Label, OptionList, PageHead, Range, Segmented, Segs } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { MEDIA_FILTER, platform } from '../../lib/platform';
import { formatDuration, pad2 } from '../../lib/text';
import { canSts, useEngine } from '../../stores/engine';
import { useSeparatorReady } from '../../lib/models';
import { usePlayer } from '../../stores/player';
import { useSettings } from '../../stores/settings';
import { RT_PRESETS, useSts, type RtPreset } from '../../stores/sts';
import { useEdit } from '../../stores/edit';
import { useUi } from '../../stores/ui';
import { Waveform } from '../../components/Waveform';
import { HotkeyPanel } from './HotkeyPanel';
import { useLiveHotkeys } from './useLiveHotkeys';
import { VirtualDeviceGuide } from './VirtualDeviceGuide';

/** URL audio kết quả (B) để vẽ waveform, chỉ lấy khi job xong. */
function useStsOutputUrl(jobId: string | undefined, done: boolean) {
  const [src, setSrc] = useState<string | Blob | null>(null);
  useEffect(() => {
    if (!jobId || !done) return void setSrc(null);
    let live = true;
    engine().stsAudio(jobId, 'b').then((a) => live && setSrc(a.url ?? null)).catch(() => live && setSrc(null));
    return () => { live = false; };
  }, [jobId, done]);
  return src;
}

export function StsPage() {
  const { t } = useTranslation();
  const s = useSts();
  const voices = useEngine((x) => x.voices);
  const rt = useEngine((x) => x.rt);
  const stsVoices = voices.filter(canSts);
  const target = stsVoices.find((v) => v.id === s.profileId) ?? stsVoices[0];

  const setPitch = (pitch: number) => {
    s.set({ pitch });
    if (rt.running) void engine().updateRealtime({ pitch });
  };

  return (
    <div className="flex flex-col gap-7">
      <PageHead code={t('sts.code')} title={t('sts.title')} desc={t('sts.desc')}>
        <Segmented mono value={s.mode} onChange={(mode) => s.set({ mode })} options={[
          { id: 'offline', label: t('sts.modeOffline') },
          { id: 'rt', label: t('sts.modeRt') },
        ]} />
      </PageHead>
      <div className="flex flex-wrap gap-4 items-start">
        <Box className="flex-[1_1_280px]" title="PARAMS">
          <div className="px-3.5 py-4 flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label>{t('sts.target')}</Label>
              {stsVoices.length ? (
                <OptionList value={target?.id} onChange={(id) => s.set({ profileId: id })} disabled={rt.running}
                  options={stsVoices.map((v) => ({ id: v.id, name: v.name }))} />
              ) : (
                <span className="text-[13px] text-acc">{t('errors.NO_STS_VOICE')}</span>
              )}
              <span className="text-[12px] text-mute">{t('sts.onlyTrained')}</span>
            </div>
            <Range label={t('sts.pitch')} valueText={`${s.pitch > 0 ? '+' : ''}${s.pitch} st`} min={-12} max={12} step={1} value={s.pitch}
              onChange={setPitch} hint={t('sts.pitchHint')} />
            {s.mode === 'rt' && (
              <Range label={t('sts.gate')} valueText={`${s.gateDb} dB`} min={-70} max={-20} step={1} value={s.gateDb}
                onChange={(gateDb) => { s.set({ gateDb }); if (rt.running) void engine().updateRealtime({ gateDb }); }} hint={t('sts.gateHint')} />
            )}
          </div>
        </Box>
        {s.mode === 'offline' ? <OfflinePanel targetId={target?.id} targetName={target?.name ?? ''} />
          : <RealtimePanel targetId={target?.id} targetName={target?.name ?? ''} voices={stsVoices.filter((v) => !v.trainJobId)} />}
      </div>
    </div>
  );
}

function OfflinePanel({ targetId, targetName }: { targetId?: string; targetName: string }) {
  const { t } = useTranslation();
  const s = useSts();
  const sepReady = useSeparatorReady();
  const jobs = useEngine((x) => x.jobs);
  const { setNotice, toast } = useUi();
  const player = usePlayer();
  const [advanced, setAdvanced] = useState(false);
  const job = s.jobId ? jobs[s.jobId] : undefined;
  const running = job?.status === 'running' || job?.status === 'queued';
  const done = job?.status === 'done';

  const setFile = async (file: FileRef) => {
    player.stop();
    s.set({ file, fileDurationSec: 0, jobId: null });
    const [d] = await engine().analyzeDataset([file]);
    s.set({ fileDurationSec: d?.durationSec ?? 0 });
  };
  const pick = async () => {
    const [f] = await platform.pickFiles({ title: t('sts.chooseFile'), filters: [MEDIA_FILTER] });
    if (f) await setFile(f);
  };
  const start = async () => {
    if (!s.file || !targetId) return;
    try {
      const jobId = await engine().startSts({ profileId: targetId, file: s.file, pitch: s.pitch, indexRate: s.indexRate, protect: s.protect, separate: s.separate && sepReady });
      s.set({ jobId });
      setNotice('');
    } catch (err) {
      setNotice(errorText(t, err));
    }
  };
  const exportOut = async () => {
    if (!job) return;
    toast(t('sts.exported'), (await engine().exportSts(job.id)) || undefined);
  };

  const stageNames = s.separate && sepReady ? ['demux', 'separate', 'convert', 'remix'] : ['demux', 'prep', 'convert', 'join'];
  const stageIdx = job ? Math.min(3, Math.floor(job.progress * 4)) : 0;
  const ab = player.key?.startsWith('sts:') ? player.key.slice(4) : null;
  const playAb = async (which: 'a' | 'b') => {
    if (!job) return;
    if (ab === which) return player.stop();
    player.play(`sts:${which}`, await engine().stsAudio(job.id, which));
  };
  const outSrc = useStsOutputUrl(job?.id, done);
  const seekAb = async (which: 'a' | 'b', f: number) => {
    if (!job) return;
    if (ab === which) return player.seek(f);
    player.play(`sts:${which}`, await engine().stsAudio(job.id, which), f);
  };
  const abBtn = (which: 'a' | 'b') => (
    <button type="button" onClick={() => void playAb(which)} aria-label={`${t('common.play')} ${which.toUpperCase()}`}
      className="bg-transparent border-0 p-0 text-mute hover:text-fg cursor-pointer font-mono text-[11px]">
      {ab === which ? '■' : '▶'}
    </button>
  );

  return (
    <Box className="flex-[2_1_420px]" title="BATCH · RMVPE">
      <div className="px-3.5 py-4 flex flex-col gap-[18px]">
        {!s.file ? (
          <DropZone caption="AUDIO / VIDEO" text={t('sts.drop')} pad="p-9"
            onFiles={(f) => f[0] && void setFile({ path: f[0].name, name: f[0].name, size: f[0].size, file: f[0] })}>
            <Btn variant="outline" onClick={() => void pick()}>{t('sts.chooseFile')}</Btn>
          </DropZone>
        ) : (
          <div className="flex flex-col gap-[18px]">
            <div className="flex justify-between flex-wrap gap-2 font-mono text-[12px]">
              <span>{s.file.name} <span className="text-mute">· {s.fileDurationSec ? formatDuration(s.fileDurationSec) : '…'}</span></span>
              <Btn variant="link" disabled={running} onClick={() => { player.stop(); s.set({ file: null, jobId: null }); }}>[{t('common.replace')}]</Btn>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex gap-2 items-center"><Label>A · {t('sts.source')}</Label>{job && abBtn('a')}</span>
              <div className="border border-line">
                <Waveform source={s.file.file} height={88} color="#8F8F8F" label={`A · ${t('sts.source')}`}
                  position={ab === 'a' ? player.position : undefined} placeholder={t('sts.noPreview')}
                  onSeek={job ? (f) => void seekAb('a', f) : undefined} />
              </div>
            </div>
            <Check id="stssep" checked={s.separate && sepReady} disabled={!sepReady} onChange={(separate) => s.set({ separate })}
              sub={sepReady ? undefined : t('models.separatorMissing')}>{t('sts.separate')}</Check>
            <button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}
              className="bg-transparent border-0 p-0 text-left text-mute hover:text-fg cursor-pointer font-mono text-[11px] tracking-label">
              {advanced ? '▾' : '▸'} {t('common.advanced')}
            </button>
            {advanced && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-5">
                <Range label="INDEX RATE" valueText={s.indexRate.toFixed(2)} min={0} max={1} step={0.05} value={s.indexRate}
                  onChange={(indexRate) => s.set({ indexRate })} hint={t('sts.indexHint')} />
                <Range label="PROTECT" valueText={s.protect.toFixed(2)} min={0} max={0.5} step={0.01} value={s.protect}
                  onChange={(protect) => s.set({ protect })} hint={t('sts.protectHint')} />
              </div>
            )}
            {job && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-4 border border-line font-mono text-[11px]">
                  {stageNames.map((n, i) => {
                    const d = done || i < stageIdx;
                    const cur = running && i === stageIdx;
                    return (
                      <span key={n} className="px-2.5 py-2 border-r border-line last:border-r-0"
                        style={{ background: d ? '#F2F2F2' : 'transparent', color: d ? '#0A0A0A' : cur ? '#FF5B14' : '#8F8F8F' }}>
                        {pad2(i + 1)} {t(`sts.stage.${n}`)}
                      </span>
                    );
                  })}
                </div>
                <div className="h-1 bg-line"><div className="h-1 bg-acc" style={{ width: `${job.progress * 100}%` }} /></div>
                {job.status === 'queued' && job.waitingFor && <span className="text-[12px] text-mute">{t('training.waitingFor', { name: job.waitingFor })}</span>}
              </div>
            )}
            {done && (
              <div className="flex flex-col gap-1.5">
                <span className="flex gap-2 items-center">
                  <span className="font-mono text-[11px] tracking-label text-acc">B · {t('sts.output')} → {targetName.toUpperCase()}</span>
                  {abBtn('b')}
                </span>
                <div className="border border-line">
                  <Waveform source={outSrc} height={88} label={`B · ${t('sts.output')}`}
                    position={ab === 'b' ? player.position : undefined}
                    onSeek={(f) => void seekAb('b', f)} />
                </div>
                {engine().mode === 'mock' && <span className="font-mono text-[10px] text-mute">{t('sts.mockNote')}</span>}
              </div>
            )}
            <div className="flex gap-2 flex-wrap justify-end">
              {done && (
                <>
                  <Btn variant="ghost" className="!font-mono !text-[12px] !font-bold"
                    onClick={() => void playAb(ab === 'a' ? 'b' : 'a')}>
                    {ab === 'a' ? '▶ B' : ab === 'b' ? '▶ A' : '▶ A/B'}
                  </Btn>
                  <Btn variant="ghost" className="!font-mono !text-[12px] !font-bold" onClick={() => void exportOut()}>{t('sts.export')}</Btn>
                  {engine().mode !== 'mock' && job && (
                    <Btn variant="ghost" className="!font-mono !text-[12px] !font-bold" onClick={() => void useEdit.getState().openFromJob(job.id)}>✂ {t('common.openInEdit')}</Btn>
                  )}
                </>
              )}
              {running && <Btn variant="ghost" onClick={() => job && void engine().cancelJob(job.id)}>{t('common.cancel')}</Btn>}
              <Btn variant="primary" onClick={() => void start()} disabled={running || !targetId}>
                {running ? t('sts.processing') : done ? `↻ ${t('sts.again')}` : `▶ ${t('sts.convert')}`}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </Box>
  );
}

function RealtimePanel({ targetId, targetName, voices }: { targetId?: string; targetName: string; voices: Profile[] }) {
  const { t } = useTranslation();
  const s = useSts();
  const rt = useEngine((x) => x.rt);
  const setNotice = useUi((x) => x.setNotice);
  const [devices, setDevices] = useState<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>({ inputs: [], outputs: [] });
  const [guide, setGuide] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [starting, setStarting] = useState(false);
  const { rtHotkeys, set: setSettings } = useSettings();

  // Phím tắt: chỉ tính phím gán cho giọng còn tồn tại; giữ phím → đổi giọng đích, nhả → về giọng mặc định.
  const assigned = useMemo(() => new Set(Object.keys(rtHotkeys).filter((d) => voices.some((v) => v.id === rtHotkeys[d]))), [rtHotkeys, voices]);
  const hk = useLiveHotkeys(rt.running, assigned);
  useEffect(() => {
    if (!rt.running || !targetId) return;
    const profileId = hk.active ? rtHotkeys[hk.active] : targetId;
    engine().updateRealtime({ profileId }).catch((err) => setNotice(errorText(t, err)));
  }, [hk.active, rt.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    const d = await engine().audioDevices();
    setDevices(d);
    const st = useSts.getState();
    if (!d.inputs.some((x) => x.id === st.inputId)) s.set({ inputId: d.inputs[0]?.id ?? '' });
    if (!d.outputs.some((x) => x.id === st.outputId)) s.set({ outputId: d.outputs[0]?.id ?? '' });
  };
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const out = devices.outputs.find((d) => d.id === s.outputId);
  const virtualInstalled = devices.outputs.some((d) => d.virtual);
  const pickPreset = (preset: RtPreset) => s.set({ preset, ...RT_PRESETS[preset] });

  const toggle = async () => {
    if (rt.running) return void engine().stopRealtime();
    if (!targetId) return setNotice(t('errors.NO_STS_VOICE'));
    setStarting(true);
    try {
      await engine().startRealtime({
        profileId: targetId, inputId: s.inputId, outputId: s.outputId, preset: s.preset, blockMs: s.blockMs,
        contextSec: s.contextSec, crossfadeMs: s.crossfadeMs, pitch: s.pitch, gateDb: s.gateDb,
      });
      setNotice('');
    } catch (err) {
      setNotice(errorText(t, err));
    } finally {
      setStarting(false);
    }
  };

  const level = (db: number) => (rt.running ? Math.max(0, Math.min(100, 100 * Math.pow(10, db / 20))) : 0);
  const dbText = (db: number) => (!rt.running ? '—' : db <= -100 ? '-∞' : db.toFixed(0));
  let status = t('sts.rt.standby');
  let statusCol = '#8F8F8F';
  if (starting) status = t('sts.rt.starting');
  else if (rt.running && rt.underrun) { status = t('sts.rt.underrun'); statusCol = '#FF5B14'; }
  else if (rt.running) { status = t('sts.rt.stable'); statusCol = '#F2F2F2'; }

  const deviceCol = (title: string, list: AudioDevice[], value: string, key: 'inputId' | 'outputId', border?: boolean) => (
    <div className={`flex flex-col ${border ? 'border-l border-line' : ''}`}>
      <span className="px-3.5 py-2 border-b border-line font-mono text-[11px] tracking-[.08em] text-mute flex justify-between">
        {title}
        {!border && (
          <button type="button" onClick={() => void refresh()} disabled={rt.running} className="bg-transparent border-0 text-mute hover:text-fg cursor-pointer p-0 font-mono text-[11px]">
            ↻ {t('sts.rt.refresh')}
          </button>
        )}
      </span>
      {list.map((d) => (
        <button key={d.id} type="button" onClick={() => s.set({ [key]: d.id })} aria-pressed={value === d.id} disabled={rt.running}
          className={`text-left border-0 border-b border-line2 px-3.5 py-2.5 cursor-pointer min-h-[44px] font-semibold ${value === d.id ? 'bg-fg text-bg' : 'bg-transparent text-fg'}`}>
          {d.name}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex-[2_1_420px] min-w-0 flex flex-col gap-4">
      <div className="border border-line grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
        {deviceCol('INPUT', devices.inputs, s.inputId, 'inputId')}
        {deviceCol('OUTPUT', devices.outputs, s.outputId, 'outputId', true)}
      </div>

      {out && !out.virtual && (
        <Alert title={t('sts.rt.virtualTitle')}>
          {virtualInstalled ? t('sts.rt.virtualSelect') : t('sts.rt.virtualInstall')}{' '}
          <a onClick={() => setGuide(true)} role="button" tabIndex={0}>{t('sts.rt.guide')}</a>
        </Alert>
      )}

      <div className="border border-line flex flex-col">
        <Segmented className="!border-0 border-b !border-b-line" value={s.preset} onChange={pickPreset} disabled={rt.running}
          options={(['low', 'balanced', 'quality'] as const).map((id) => ({ id, label: t(`sts.rt.preset.${id}`), desc: `BLOCK ${RT_PRESETS[id].blockMs}ms` }))} />
        <div className="px-3.5 pt-3">
          <button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}
            className="bg-transparent border-0 p-0 text-left text-mute hover:text-fg cursor-pointer font-mono text-[11px] tracking-label">
            {advanced ? '▾' : '▸'} {t('common.advanced')}
          </button>
          {advanced && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-5 pt-3">
              <Range label="BLOCK" valueText={`${s.blockMs} ms`} min={100} max={250} step={10} value={s.blockMs} disabled={rt.running} onChange={(blockMs) => s.set({ blockMs })} />
              <Range label="CONTEXT" valueText={`${s.contextSec.toFixed(1)} s`} min={1} max={2} step={0.1} value={s.contextSec} disabled={rt.running} onChange={(contextSec) => s.set({ contextSec })} />
              <Range label="CROSSFADE" valueText={`${s.crossfadeMs} ms`} min={20} max={120} step={10} value={s.crossfadeMs} disabled={rt.running} onChange={(crossfadeMs) => s.set({ crossfadeMs })} />
            </div>
          )}
        </div>
        <div className="px-3.5 py-[18px] flex flex-col gap-2.5 font-mono text-[11px]">
          <div className="flex items-center gap-3"><span className="w-8 text-mute">IN</span><Segs level={level(rt.inDb)} /><span className="w-11 text-right">{dbText(rt.inDb)}</span></div>
          <div className="flex items-center gap-3"><span className="w-8 text-mute">OUT</span><Segs level={level(rt.outDb)} /><span className="w-11 text-right">{dbText(rt.outDb)}</span></div>
        </div>
        <div className="flex flex-wrap items-stretch border-t border-line">
          <div className="flex-[1_1_140px] px-3.5 py-3 border-r border-line">
            <div className="font-mono text-[11px] tracking-label text-mute">{t('sts.rt.latency')}</div>
            <div className="font-mono text-[28px] font-bold">{rt.running ? `${rt.latencyMs}ms` : '---ms'}</div>
          </div>
          <div className="flex-[1_1_180px] px-3.5 py-3 border-r border-line">
            <div className="font-mono text-[11px] tracking-label text-mute">{t('sts.rt.status')}</div>
            <div className="font-bold pt-1.5" style={{ color: statusCol }}>{status}</div>
            {rt.running && rt.underruns > 0 && <div className="font-mono text-[11px] text-mute">{t('sts.rt.underrunCount', { count: rt.underruns })}</div>}
          </div>
          <button type="button" onClick={() => void toggle()} disabled={starting}
            className={`flex-[0_1_200px] border-0 px-6 py-3.5 font-mono font-bold text-[14px] tracking-[.14em] cursor-pointer min-h-[64px] text-bg ${rt.running ? 'bg-fg' : 'bg-acc hover:bg-acc2'}`}>
            {rt.running ? `■ ${t('common.stop').toUpperCase()}` : `● ${t('sts.rt.start')}`}
          </button>
        </div>
      </div>
      <HotkeyPanel voices={voices} hotkeys={rtHotkeys} active={hk.active} mode={hk.mode} error={hk.error} running={rt.running}
        defaultName={targetName}
        onChange={(d, id) => {
          const next = { ...rtHotkeys };
          if (id) next[d] = id;
          else delete next[d];
          setSettings({ rtHotkeys: next });
        }} />
      {guide && <VirtualDeviceGuide onClose={() => setGuide(false)} />}
    </div>
  );
}
