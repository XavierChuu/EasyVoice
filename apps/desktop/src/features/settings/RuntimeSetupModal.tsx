// Bản cài đặt, lần mở đầu tiên (spec mục 8): cài runtime Python của engine (uv → Python → venv → PyTorch → thư viện).
// Người dùng không phải tự cài Python/CUDA; mọi thứ nằm trong thư mục dữ liệu của app. Xong thì tải lại cửa sổ để
// kết nối engine vừa khởi động, rồi tới màn hình tải model (FirstRunModal).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, Btn, KvRows, Modal, Progress } from '../../components/ui';
import { osName, platform, type RuntimeInfo, type RuntimeProgress } from '../../lib/platform';

export function RuntimeSetupModal() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [prog, setProg] = useState<RuntimeProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void platform.runtimeInfo().then((i) => {
      setInfo(i);
      if (i?.installing) setRunning(true);
    });
    return platform.onRuntimeProgress(setProg);
  }, []);

  const install = async () => {
    setRunning(true);
    setError(null);
    try {
      await platform.installRuntime();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
      setRunning(false);
    }
  };

  const overall = prog ? (prog.index - 1 + (prog.fraction ?? (prog.step === 'done' ? 1 : 0.5))) / prog.total : 0;
  return (
    <Modal title={t('runtime.title')} onClose={() => {}} width={640} footer={
      <Btn variant="primary" disabled={running || !info} onClick={() => void install()}>
        {error ? `↻ ${t('firstRun.retry')}` : `↓ ${t('runtime.install', { size: info?.sizeGb.toFixed(1) ?? '…' })}`}
      </Btn>
    }>
      <p className="m-0 text-soft">{t('runtime.intro')}</p>
      <KvRows title={t('firstRun.check')} rows={[
        { k: 'PyTorch', v: info ? t(`runtime.torch.${info.torch}`) : '—', bad: info?.torch === 'cpu' },
        { k: t('runtime.dir'), v: <span className="break-all">{info?.dir ?? '—'}</span> },
      ]} />
      {info?.torch === 'cpu' && (osName() === 'mac' // [Mac Intel] (Apple Silicon luôn là MPS, Windows giữ thông báo NVIDIA)
        ? <Alert tone="line" title={t('runtime.cpuTitleMac')}>{t('runtime.cpuBodyMac')}</Alert>
        : <Alert tone="line" title={t('runtime.cpuTitle')}>{t('runtime.cpuBody')}</Alert>)}
      {(running || prog) && !error && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between gap-3 font-mono text-[12px]">
            <span className="text-acc">{prog ? `${prog.index}/${prog.total} · ${t(`runtime.step.${prog.step}`)}` : t('firstRun.waiting')}</span>
            <span>{Math.round(overall * 100)}%</span>
          </div>
          <Progress value={overall} />
          <span className="font-mono text-[11px] text-mute truncate" title={prog?.line}>{prog?.line ?? ''}</span>
          <span className="text-[12px] text-mute">{t('runtime.hint')}</span>
        </div>
      )}
      {error && (
        <Alert title={t('runtime.failed')}>
          <span className="whitespace-pre-wrap font-mono text-[11px] block max-h-40 overflow-auto">{error}</span>
          <span className="block mt-1">{t('runtime.failedHint')}</span>
        </Alert>
      )}
    </Modal>
  );
}
