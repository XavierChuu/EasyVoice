// Màn hình chạy lần đầu (spec mục 8): kiểm tra GPU/driver/ổ trống, chọn và tải model cần thiết.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import { Alert, Btn, Check, KvRows, Modal, Progress } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { useEngine } from '../../stores/engine';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';

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
  const running = job?.status === 'queued' || job?.status === 'running';
  const failed = job?.status === 'failed' || job?.status === 'cancelled';
  const done = job?.status === 'done' || (!jobId && models.length > 0 && models.every((m) => m.installed));
  const finish = () => set({ firstRunDone: true });
  const start = async () => {
    try {
      setJobId(await engine().downloadModels(picked.map((m) => m.id)));
    } catch (err) {
      useUi.getState().setNotice(errorText(t, err));
    }
  };
  // Tiến độ chi tiết engine gửi kèm (MB đã tải / tổng, file đang tải)
  const info = (job?.result ?? {}) as { doneMb?: number; totalMb?: number; file?: string; speedMbps?: number };
  const fmtMb = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : `${Math.round(mb)} MB`);

  return (
    <Modal title={t('firstRun.title')} onClose={finish} width={640} footer={
      done ? <Btn variant="primary" onClick={finish}>{t('firstRun.start')}</Btn> : (
        <>
          {running && <Btn variant="ghost" onClick={() => job && void engine().cancelJob(job.id)}>{t('common.cancel')}</Btn>}
          <Btn variant="ghost" onClick={finish} disabled={running}>{t('firstRun.skip')}</Btn>
          <Btn variant="primary" disabled={running || !picked.length} onClick={() => void start()}>
            {failed ? `↻ ${t('firstRun.retry')}` : `↓ ${t('firstRun.download', { size: (sizeMb / 1000).toFixed(1) })}`}
          </Btn>
        </>
      )
    }>
      <p className="m-0 text-soft">{t('firstRun.intro')}</p>
      <KvRows title={t('firstRun.check')} rows={[
        { k: 'GPU', v: `${system?.gpu ?? '—'} · ${system?.device ?? ''}` },
        { k: t('firstRun.driver'), v: system?.driverOk ? 'OK' : t('firstRun.driverOld'), bad: !system?.driverOk },
        { k: t('firstRun.disk'), v: `${(system?.diskFreeGb ?? 0).toFixed(1)} GB`, bad: (system?.diskFreeGb ?? 0) < 15 },
      ]} />
      <div className="border border-line">
        {(['tts', 'sts', 'common'] as const).filter((g) => models.some((m) => m.group === g)).map((g) => {
          const list = models.filter((m) => m.group === g);
          return (
            <div key={g} className="p-3 border-b border-line2 last:border-b-0">
              <Check id={`fr-${g}`} checked={groups[g]} disabled={running} onChange={(v) => setGroups({ ...groups, [g]: v })}
                sub={list.map((m) => `${m.name}${m.installed ? ' ✓' : ''}`).join(' · ')}>
                {t(`firstRun.group.${g}`)} · {(list.filter((m) => !m.installed).reduce((a, m) => a + m.sizeMb, 0) / 1000).toFixed(1)} GB
              </Check>
            </div>
          );
        })}
      </div>
      {job && !failed && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between gap-3 font-mono text-[12px]">
            <span className="text-acc">{done ? t('firstRun.done') : job.status === 'queued' ? t('firstRun.waiting') : t('firstRun.downloading')}</span>
            <span>
              {info.totalMb ? `${fmtMb(info.doneMb ?? 0)} / ${fmtMb(info.totalMb)} · ` : ''}
              {running && info.speedMbps ? `${info.speedMbps.toFixed(1)} MB/s · ` : ''}
              {(job.progress * 100).toFixed(1)}%
            </span>
          </div>
          <Progress value={job.progress} />
          {running && info.file && <span className="font-mono text-[11px] text-mute break-all">{info.file}</span>}
          {running && job.log.length > 0 && /thử lại/.test(job.log[job.log.length - 1]) && (
            <span className="text-[12px] text-acc">{job.log[job.log.length - 1]}</span>
          )}
          <span className="text-[12px] text-mute">{t('firstRun.resumeNote')}</span>
        </div>
      )}
      {job && failed && (
        <Alert title={job.status === 'cancelled' ? t('firstRun.cancelled') : t('firstRun.failed')}>
          {(job.errorDetail ?? '').split(' | ').filter(Boolean).map((line) => <span key={line} className="block">{line}</span>)}
          <span className="block mt-1 text-mute text-[12px]">{t('firstRun.failedHint')}</span>
        </Alert>
      )}
    </Modal>
  );
}
