import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Btn, Label, PageHead, Segmented } from '../../components/ui';
import { platform } from '../../lib/platform';
import { useEngine } from '../../stores/engine';
import { useSettings } from '../../stores/settings';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(180px,260px)_1fr] gap-x-6 gap-y-2 px-4 py-4 border-b border-line2 last:border-b-0 max-[720px]:grid-cols-1">
      <div className="flex flex-col gap-1">
        <Label>{label}</Label>
        {hint && <span className="text-[12px] text-mute">{hint}</span>}
      </div>
      <div className="min-w-0 flex flex-col gap-2 justify-center">{children}</div>
    </div>
  );
}

function FolderRow({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Row label={label} hint={hint}>
      <div className="flex gap-2 items-center flex-wrap">
        <span className="font-mono text-[12px] border border-line px-3 py-2.5 flex-1 min-w-[200px] break-all">{value || t('settings.defaultFolder')}</span>
        <Btn variant="ghost" onClick={async () => { const p = await platform.pickFolder(label); if (p) onChange(p); }}>{t('settings.choose')}</Btn>
        {value && <Btn variant="link" onClick={() => onChange('')}>[{t('settings.reset')}]</Btn>}
      </div>
    </Row>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const st = useSettings();
  const system = useEngine((s) => s.system);
  const info = useEngine((s) => s.info);
  return (
    <div className="flex flex-col gap-7">
      <PageHead code={t('settings.code')} title={t('settings.title')} desc={t('settings.desc')} />
      <div className="border border-line">
        <Row label={t('settings.language')}>
          <Segmented value={st.lang} onChange={(lang) => st.set({ lang })} options={[{ id: 'vi', label: 'Tiếng Việt' }, { id: 'en', label: 'English' }]} />
        </Row>
        <FolderRow label={t('settings.modelsDir')} hint={t('settings.modelsHint')} value={st.modelsDir} onChange={(modelsDir) => st.set({ modelsDir })} />
        <FolderRow label={t('settings.voicesDir')} hint={t('settings.voicesHint')} value={st.voicesDir} onChange={(voicesDir) => st.set({ voicesDir })} />
        <Row label={t('settings.device')} hint={t('settings.deviceHint')}>
          <Segmented value={st.device} onChange={(device) => st.set({ device })} options={[
            { id: 'auto', label: t('settings.deviceAuto') },
            { id: 'gpu', label: `GPU · ${system?.device ?? '—'}` },
            { id: 'cpu', label: t('settings.deviceCpu') },
          ]} />
          {st.device === 'cpu' && <span className="text-[12px] text-acc">{t('settings.cpuWarn')}</span>}
        </Row>
        <Row label={t('settings.format')}>
          <Segmented value={st.ttsFormat} onChange={(ttsFormat) => st.set({ ttsFormat })} options={[{ id: 'wav', label: 'WAV 24 kHz' }, { id: 'mp3', label: 'MP3' }, { id: 'flac', label: 'FLAC' }]} />
        </Row>
        <Row label={t('settings.privacy')} hint={t('settings.privacyHint')}>
          <span className="font-mono text-[12px]">TELEMETRY: <span className="text-acc">OFF</span> · {t('settings.privacyBody')}</span>
        </Row>
        <Row label={t('settings.engine')}>
          <span className="font-mono text-[12px]">v{system?.appVersion} · ENGINE {t(`shell.engine.${info.status}`)} · {system?.gpu} · {system?.device}</span>
          <div className="flex gap-2 flex-wrap">
            <Btn variant="ghost" onClick={() => st.set({ firstRunDone: false })}>{t('settings.rerunSetup')}</Btn>
            <Btn variant="ghost" disabled={info.status === 'mock'} onClick={() => void platform.restartEngine()}>{t('engineBanner.restart')}</Btn>
          </div>
        </Row>
      </div>
    </div>
  );
}
