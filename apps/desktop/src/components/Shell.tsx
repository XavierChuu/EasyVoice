import { useTranslation } from 'react-i18next';

import { platform } from '../lib/platform';
import { pad2 } from '../lib/text';
import { runningJob, useEngine } from '../stores/engine';
import { useSettings } from '../stores/settings';
import { useUi, type Tab } from '../stores/ui';
import { Logo } from './Logo';
import { Alert, Btn, CloseBtn, Icon, ICONS } from './ui';

function useBusy() {
  const { t } = useTranslation();
  const jobs = useEngine((s) => s.jobs);
  const rt = useEngine((s) => s.rt);
  const cur = runningJob(jobs);
  const queued = Object.values(jobs).filter((j) => j.kind !== 'download' && j.status === 'queued').length;
  let busyText = t('shell.busy.idle');
  let queueText = t('shell.queue.empty');
  if (rt.running) {
    busyText = t('shell.busy.rt');
    queueText = t('shell.queue.rt');
  } else if (cur?.kind === 'tts') {
    busyText = t('shell.busy.tts');
    queueText = t('shell.queue.tts');
  } else if (cur?.kind === 'sts') {
    busyText = t('shell.busy.sts');
    queueText = t('shell.queue.sts');
  } else if (cur?.kind === 'edit' || cur?.kind === 'mix') {
    busyText = t('shell.busy.edit');
    queueText = t('shell.queue.edit', { name: cur.label });
  } else if (cur?.kind === 'train') {
    busyText = t('shell.busy.train');
    queueText = t('shell.queue.train', { name: cur.label });
  }
  if (queued) queueText += ' · ' + t('shell.queue.waiting', { count: queued });
  return { busy: rt.running || !!cur, busyText, queueText };
}

export function Header() {
  const { t } = useTranslation();
  const info = useEngine((s) => s.info);
  const system = useEngine((s) => s.system);
  const lang = useSettings((s) => s.lang);
  const set = useSettings((s) => s.set);
  const engineCls = info.status === 'online' || info.status === 'mock' ? 'text-fg' : 'text-acc';
  return (
    <header className="flex items-center justify-between gap-4 flex-wrap px-5 py-2.5 border-b border-line font-mono text-[11px] tracking-[.08em] text-mute">
      <div className="flex items-center gap-3">
        <span className="text-fg flex"><Logo height={18} /></span>
        <span>v{system?.appVersion ?? '0.1.0'}</span>
      </div>
      <div className="flex gap-5 flex-wrap items-center">
        <span>{t('shell.mode')}</span>
        <span>BACKEND: 127.0.0.1{info.port ? `:${info.port}` : ''}</span>
        <span>ENGINE: <span className={engineCls}>{t(`shell.engine.${info.status}`)}</span></span>
        <div className="flex border border-line3" role="group" aria-label={t('settings.language')}>
          {(['vi', 'en'] as const).map((l) => (
            <button key={l} type="button" onClick={() => set({ lang: l })} aria-pressed={lang === l}
              className={`border-0 px-2 py-0.5 cursor-pointer font-mono text-[11px] ${lang === l ? 'bg-fg text-bg' : 'bg-transparent text-mute'}`}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const system = useEngine((s) => s.system);
  const { queueText } = useBusy();
  const main: [Tab, string, string][] = [
    ['voices', t('nav.voices'), ICONS.voices],
    ['tts', t('nav.tts'), ICONS.tts],
    ['sts', t('nav.sts'), ICONS.sts],
    ['edit', t('nav.edit'), ICONS.edit],
  ];
  const extra: [Tab, string, string][] = [
    ['settings', t('nav.settings'), ICONS.settings],
    ['licenses', t('nav.licenses'), ICONS.licenses],
  ];
  const vramUsed = system?.vramUsedGb ?? 0;
  const vramTotal = system?.vramTotalGb ?? 12;
  const lit = Math.round((vramUsed / vramTotal) * 24);
  return (
    <nav aria-label={t('nav.aria')} className="flex-[1_1_232px] max-w-full border-r border-line py-6 flex flex-col gap-6">
      <div className="px-5 font-mono text-[11px] tracking-wide2 text-mute">{t('nav.modules')}</div>
      <div className="flex flex-col">
        {main.map(([id, label, icon], i) => (
          <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
            className={`flex items-center gap-3.5 border-0 px-5 py-3.5 min-h-[48px] text-[15px] font-semibold text-left cursor-pointer ${tab === id ? 'bg-fg text-bg' : 'bg-transparent text-fg hover:bg-line2'}`}>
            <span className="font-mono text-[11px] opacity-70">{pad2(i + 1)}</span>
            <span className="flex-grow">{label}</span>
            <Icon d={icon} />
          </button>
        ))}
      </div>
      <div className="flex-grow" />
      <div className="flex flex-col">
        {extra.map(([id, label, icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
            className={`flex items-center gap-3.5 border-0 px-5 py-2.5 min-h-[40px] text-[13px] font-semibold text-left cursor-pointer ${tab === id ? 'bg-fg text-bg' : 'bg-transparent text-mute hover:text-fg'}`}>
            <Icon d={icon} size={14} />
            <span className="flex-grow">{label}</span>
          </button>
        ))}
      </div>
      <div className="mx-5 border border-line font-mono text-[11px]">
        <div className="px-3 py-2 border-b border-line tracking-wide2 text-mute">{t('shell.hardware')}</div>
        <div className="p-3 flex flex-col gap-2.5">
          <div className="flex justify-between"><span className="text-mute">GPU</span><span>{system?.gpu ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-mute">BACKEND</span><span>{system?.device ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-mute">VRAM</span><span>{vramUsed.toFixed(1)}/{vramTotal.toFixed(1)} GB</span></div>
          <div className="flex gap-[2px]">
            {Array.from({ length: 24 }, (_, i) => (
              <div key={i} className="flex-1 h-2" style={{ background: i < lit ? (i >= 18 ? '#FF5B14' : '#F2F2F2') : '#1C1C1C' }} />
            ))}
          </div>
        </div>
        <div className="px-3 py-2.5 border-t border-line text-mute font-sans text-[12px]">{queueText}</div>
      </div>
      <div className="px-5 font-mono text-[10px] tracking-label text-mute">{t('shell.local')}</div>
    </nav>
  );
}

export function Footer() {
  const { t } = useTranslation();
  const system = useEngine((s) => s.system);
  const rt = useEngine((s) => s.rt);
  const voices = useEngine((s) => s.voices);
  const { busy, busyText } = useBusy();
  const cell = 'px-4 py-2 border-r border-line';
  return (
    <footer className="flex flex-wrap border-t border-line font-mono text-[11px] tracking-[.06em] text-mute">
      <span className={`${cell} flex items-center gap-2`}><span className="w-[7px] h-[7px]" style={{ background: busy ? '#FF5B14' : '#3D3D3D' }} />{busyText}</span>
      <span className={cell}>DEVICE {system?.device ?? '—'}</span>
      <span className={cell}>VRAM {(system?.vramUsedGb ?? 0).toFixed(1)}/{(system?.vramTotalGb ?? 0).toFixed(1)} GB</span>
      <span className={cell}>LAT {rt.running ? `${rt.latencyMs}ms` : '---ms'}</span>
      <span className="px-4 py-2 flex-grow text-right">{t('shell.profiles')} {pad2(voices.length)}</span>
    </footer>
  );
}

export function NoticeBar() {
  const { t } = useTranslation();
  const notice = useUi((s) => s.notice);
  const setNotice = useUi((s) => s.setNotice);
  if (!notice) return null;
  return (
    <div role="status" className="flex items-center gap-3 border border-acc px-3.5 py-1">
      <span className="font-mono font-bold text-acc">[!]</span>
      <span className="flex-grow">{notice}</span>
      <CloseBtn onClick={() => setNotice('')} label={t('common.dismiss')} />
    </div>
  );
}

export function EngineBanner() {
  const { t } = useTranslation();
  const info = useEngine((s) => s.info);
  if (info.status !== 'restarting' && info.status !== 'offline') return null;
  return (
    <Alert
      title={t(`engineBanner.${info.status}.title`)}
      action={info.status === 'offline' ? <Btn variant="ghost" onClick={() => void platform.restartEngine()}>{t('engineBanner.restart')}</Btn> : undefined}
    >
      {t(`engineBanner.${info.status}.body`)}
      {info.lastError && <span className="block font-mono text-[11px] text-mute mt-1 break-all">{info.lastError}</span>}
    </Alert>
  );
}

export function Toasts() {
  const { t } = useTranslation();
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="fixed bottom-12 right-5 z-40 flex flex-col gap-2 w-[360px] max-w-[calc(100vw-40px)]" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className="bg-bg border border-fg flex items-start gap-3 pl-3.5 py-1 pr-1 shadow-[0_8px_24px_rgba(0,0,0,.6)]">
          <span className="font-mono font-bold text-acc pt-2.5 text-[12px]">OK</span>
          <div className="flex-grow py-2.5 flex flex-col gap-1">
            <span>{x.text}</span>
            {x.path && (
              <span className="flex flex-wrap gap-x-3 items-center">
                <span className="font-mono text-[11px] text-mute break-all">{x.path}</span>
                <Btn variant="link" className="!min-h-0 text-[11px]" onClick={() => void platform.showInFolder(x.path!)}>[{t('common.showInFolder')}]</Btn>
              </span>
            )}
          </div>
          <CloseBtn onClick={() => dismiss(x.id)} label={t('common.dismiss')} />
        </div>
      ))}
    </div>
  );
}
