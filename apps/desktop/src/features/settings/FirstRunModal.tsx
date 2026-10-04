// Màn hình chạy lần đầu (spec mục 8): kiểm tra GPU/driver/ổ trống, chọn và tải model cần thiết.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import { Btn, Check, KvRows, Modal, Progress } from '../../components/ui';
import { useEngine } from '../../stores/engine';
import { useSettings } from '../../stores/settings';

export function FirstRunModal() {
  const { t } = useTranslation();
  const system = useEngine((s) => s.system);
  const jobs = useEngine((s) => s.jobs);
  const set = useSettings((s) => s.set);
  const [groups, setGroups] = useState<Record<string, boolean>>({ tts: true, sts: true, common: true });
  const [jobId, setJobId] = useState<string | null>(null);
  const models = system?.models ?? [];

  const picked = useMemo(
    () => models.filter((m) => !m.installed && groups[m.group] && (m.required || groups.common)),
    [models, groups],
  );
  const sizeMb = picked.reduce((a, m) => a + m.sizeMb, 0);
  const job = jobId ? jobs[jobId] : undefined;
  const done = job?.status === 'done' || (!jobId && models.length > 0 && models.every((m) => m.installed));
  const finish = () => set({ firstRunDone: true });

  return (
    <Modal title={t('firstRun.title')} onClose={finish} width={640} footer={
      done ? <Btn variant="primary" onClick={finish}>{t('firstRun.start')}</Btn> : (
        <>
          <Btn variant="ghost" onClick={finish} disabled={!!job}>{t('firstRun.skip')}</Btn>
          <Btn variant="primary" disabled={!!job || !picked.length} onClick={async () => setJobId(await engine().downloadModels(picked.map((m) => m.id)))}>
            ↓ {t('firstRun.download', { size: (sizeMb / 1000).toFixed(1) })}
          </Btn>
        </>
      )
    }>
      <p className="m-0 text-soft">{t('firstRun.intro')}</p>
      <KvRows title={t('firstRun.check')} rows={[
        { k: 'GPU', v: `${system?.gpu ?? '—'} · ${system?.device ?? ''}` },
        { k: t('firstRun.driver'), v: system?.driverOk ? 'OK' : t('firstRun.driverOld'), bad: !system?.driverOk },
        { k: t('firstRun.disk'), v: `${system?.diskFreeGb ?? 0} GB`, bad: (system?.diskFreeGb ?? 0) < 15 },
      ]} />
      <div className="border border-line">
        {(['tts', 'sts', 'common'] as const).filter((g) => models.some((m) => m.group === g)).map((g) => {
          const list = models.filter((m) => m.group === g);
          return (
            <div key={g} className="p-3 border-b border-line2 last:border-b-0">
              <Check id={`fr-${g}`} checked={groups[g]} disabled={!!job} onChange={(v) => setGroups({ ...groups, [g]: v })}
                sub={list.map((m) => `${m.name}${m.installed ? ' ✓' : ''}`).join(' · ')}>
                {t(`firstRun.group.${g}`)} · {(list.filter((m) => !m.installed).reduce((a, m) => a + m.sizeMb, 0) / 1000).toFixed(1)} GB
              </Check>
            </div>
          );
        })}
      </div>
      {job && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between font-mono text-[12px]">
            <span className="text-acc">{done ? t('firstRun.done') : t('firstRun.downloading')}</span>
            <span>{(job.progress * 100).toFixed(0)}%</span>
          </div>
          <Progress value={job.progress} />
          <span className="text-[12px] text-mute">{t('firstRun.resumeNote')}</span>
        </div>
      )}
    </Modal>
  );
}
