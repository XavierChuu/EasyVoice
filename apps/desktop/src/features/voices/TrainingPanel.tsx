import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { Job, Profile, TrainStage } from '../../api/types';
import { Alert, Btn, ConfirmModal, Panel, Progress } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { pad2 } from '../../lib/text';
import { useUi } from '../../stores/ui';

const STAGES: TrainStage[] = ['preprocess', 'extract', 'train', 'index'];
const BOUNDS = [0, 0.15, 0.3, 0.92, 1];

export function TrainingPanel({ profile, job, onClose }: { profile: Profile; job: Job; onClose: () => void }) {
  const { t } = useTranslation();
  const setNotice = useUi((s) => s.setNotice);
  const [confirm, setConfirm] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [job.log.length]);

  const resume = async () => {
    try {
      await engine().resumeJob(job.id);
    } catch (err) {
      setNotice(errorText(t, err));
    }
  };
  const active = job.status === 'running' || job.status === 'queued';
  const statusText = job.status === 'done' ? t('training.done') : job.status === 'paused' ? t('training.paused')
    : job.status === 'queued' ? t('training.queued') : t(`training.stage.${job.stage ?? 'preprocess'}`);

  return (
    <Panel title={`TRAINING · ${profile.name.toUpperCase()}`} label={t('training.aria')} onClose={onClose}>
      <div className="p-5 flex flex-col gap-5">
        <div className="grid grid-cols-4 border border-line font-mono text-[11px]">
          {STAGES.map((s, i) => {
            const done = job.progress >= BOUNDS[i + 1];
            const cur = !done && job.progress >= BOUNDS[i];
            return (
              <span key={s} className="px-2.5 py-2 border-r border-line last:border-r-0"
                style={{ background: done ? '#F2F2F2' : 'transparent', color: done ? '#0A0A0A' : cur ? '#FF5B14' : '#8F8F8F' }}>
                {pad2(i + 1)} {t(`training.stage.${s}`)}
              </span>
            );
          })}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex justify-between font-mono text-[12px] flex-wrap gap-2">
            <span className="text-acc">{statusText}</span>
            <span>
              {job.epoch ? `EPOCH ${job.epoch}/${job.totalEpochs} · ` : ''}{(job.progress * 100).toFixed(1)}%
            </span>
          </div>
          <Progress value={job.progress} />
          {job.status === 'queued' && job.waitingFor && <span className="text-mute text-[12px]">{t('training.waitingFor', { name: job.waitingFor })}</span>}
        </div>
        <div ref={logRef} className="border border-line bg-[#060606] font-mono text-[11px] text-soft p-3 h-[180px] overflow-auto whitespace-pre-wrap" aria-label="log">
          {job.log.map((l, i) => <div key={i}><span className="text-dim">{pad2(i + 1)} </span>{l}</div>)}
        </div>
        {job.status === 'paused' && <Alert tone="line" title={t('training.pausedTitle')}>{t('training.pausedBody')}</Alert>}
        <div className="flex justify-between items-center flex-wrap gap-3">
          <span className="text-[12px] text-mute">{t('training.background')}</span>
          <div className="flex gap-2">
            {active && <Btn variant="ghost" onClick={() => setConfirm(true)}>■ {t('training.pause')}</Btn>}
            {job.status === 'paused' && <Btn variant="primary" onClick={() => void resume()}>▶ {t('training.resume')}</Btn>}
            <Btn variant="inverse" onClick={onClose}>{t('common.close').toUpperCase()}</Btn>
          </div>
        </div>
      </div>
      {confirm && (
        <ConfirmModal title={t('training.pauseConfirmTitle')} body={t('training.pauseConfirmBody')}
          confirmLabel={t('training.pause')} onConfirm={() => void engine().cancelJob(job.id)} onClose={() => setConfirm(false)} />
      )}
    </Panel>
  );
}
