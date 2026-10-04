// Thu đoạn ref 5-12 s trong renderer (MediaRecorder). Luồng real-time không đi qua đây — Python tự mở micro.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { FileRef } from '../../api/types';
import { Alert, Bars, Btn, Label, Modal, Segs } from '../../components/ui';
import { isElectron, osName, platform } from '../../lib/platform';
import { usePlayer } from '../../stores/player';

const MAX_SEC = 12;
const MIN_SEC = 5;

type MicError = 'denied' | 'notFound' | 'busy' | 'insecure' | 'other';

function classify(err: unknown): MicError {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notFound';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'other';
}

export function Recorder({ onDone, onClose }: { onDone: (ref: FileRef) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const player = usePlayer();
  const [state, setState] = useState<'idle' | 'recording' | 'done'>('idle');
  const [error, setError] = useState<MicError | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [result, setResult] = useState<{ blob: Blob; url: string } | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);

  const cleanup = () => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((tr) => tr.stop());
    stream.current = null;
  };
  useEffect(() => () => { cleanup(); player.stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const listDevices = async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((d) => d.kind === 'audioinput');
    setDevices(inputs);
    return inputs;
  };
  useEffect(() => { if (navigator.mediaDevices) void listDevices(); }, []);

  const start = async () => {
    setError(null);
    player.stop();
    if (!navigator.mediaDevices?.getUserMedia) return setError('insecure');
    if ((await platform.micAccess()) === 'denied') return setError('denied');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      stream.current = s;
      void listDevices(); // sau khi có quyền mới đọc được tên thiết bị
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const chunks: Blob[] = [];
      const r = new MediaRecorder(s);
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
        setResult({ blob, url: URL.createObjectURL(blob) });
        setState('done');
        void ctx.close();
        cleanup();
      };
      rec.current = r;
      r.start(250);
      setState('recording');
      const t0 = performance.now();
      const loop = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
        setLevel(Math.max(0, Math.min(100, ((db + 60) / 60) * 100)));
        const sec = (performance.now() - t0) / 1000;
        setElapsed(sec);
        if (sec >= MAX_SEC) {
          if (r.state === 'recording') r.stop();
        } else {
          raf.current = requestAnimationFrame(loop);
        }
      };
      loop();
    } catch (err) {
      cleanup();
      setError(classify(err));
    }
  };

  const stop = () => rec.current?.state === 'recording' && rec.current.stop();
  const use = () => {
    if (!result) return;
    const ext = result.blob.type.includes('ogg') ? 'ogg' : result.blob.type.includes('mp4') ? 'm4a' : 'webm';
    const name = `recording-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${ext}`;
    const file = new File([result.blob], name, { type: result.blob.type });
    onDone({ path: name, name, size: file.size, file });
  };
  const again = () => {
    player.stop();
    setResult(null);
    setElapsed(0);
    setState('idle');
  };
  const playing = player.key === 'recorder';
  const os = isElectron() ? osName() : 'browser';

  return (
    <Modal title={t('recorder.title')} onClose={() => { stop(); onClose(); }} footer={
      state === 'done' ? (
        <>
          <Btn variant="ghost" onClick={again}>{t('recorder.again')}</Btn>
          <Btn variant="primary" onClick={use} disabled={elapsed < MIN_SEC}>{t('recorder.use')}</Btn>
        </>
      ) : state === 'recording' ? (
        <Btn variant="inverse" onClick={stop}>■ {t('recorder.stop')}</Btn>
      ) : (
        <Btn variant="primary" onClick={() => void start()}>● {t('recorder.start')}</Btn>
      )
    }>
      <p className="m-0 text-soft">{t('recorder.hint')}</p>
      <div className="border border-line p-3.5 italic text-soft">“{t('recorder.script')}”</div>
      {devices.length > 0 && state === 'idle' && (
        <label className="flex flex-col gap-1.5">
          <Label>{t('recorder.device')}</Label>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
            className="bg-bg border border-line3 p-2.5 text-fg rounded-none">
            <option value="">{t('recorder.defaultDevice')}</option>
            {devices.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `${t('recorder.mic')} ${i + 1}`}</option>
            ))}
          </select>
        </label>
      )}
      {state !== 'done' ? (
        <div className="flex items-center gap-3 font-mono text-[11px]">
          <span className="w-10 text-mute">IN</span>
          <Segs level={state === 'recording' ? level : 0} />
          <span className="w-20 text-right">{elapsed.toFixed(1)}s / {MAX_SEC}s</span>
        </div>
      ) : (
        <div className="border border-line">
          <div className="flex justify-between items-center px-3 py-2 border-b border-line font-mono text-[12px]">
            <span>{t('recorder.take')} <span className="text-mute">· {elapsed.toFixed(1)}s</span></span>
            <Btn variant="link" onClick={() => (playing ? player.stop() : result && player.play('recorder', { durationSec: elapsed, url: result.url }))}>
              [{playing ? `■ ${t('common.stop')}` : `▶ ${t('recorder.listen')}`}]
            </Btn>
          </div>
          <Bars seed={1.7} n={60} height={48} playhead={playing ? player.position : undefined} />
        </div>
      )}
      {state === 'recording' && elapsed > 1.5 && level < 5 && <Alert tone="line" title={t('recorder.silent')}>{t('recorder.silentBody')}</Alert>}
      {state === 'done' && elapsed < MIN_SEC && <Alert title={t('recorder.tooShort', { min: MIN_SEC })} />}
      {player.error && playing === false && state === 'done' && <Alert title={t('recorder.playFail')} />}
      {error && (
        <Alert title={t(`recorder.err.${error}.title`)}>
          {error === 'denied' ? t(`recorder.err.denied.${os === 'mac' ? 'mac' : os === 'windows' ? 'windows' : 'browser'}`) : t(`recorder.err.${error}.body`)}
        </Alert>
      )}
    </Modal>
  );
}
