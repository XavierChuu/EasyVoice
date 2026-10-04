// Thu đoạn ref 5-12 s trong renderer (MediaRecorder). Luồng real-time không đi qua đây — Python tự mở micro.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { FileRef } from '../../api/types';
import { Alert, Btn, Modal, Segs } from '../../components/ui';

const MAX_SEC = 12;
const MIN_SEC = 5;

export function Recorder({ onDone, onClose }: { onDone: (ref: FileRef) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'recording' | 'done' | 'error'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);

  const cleanup = () => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((tr) => tr.stop());
    stream.current = null;
  };
  useEffect(() => cleanup, []);

  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } });
      stream.current = s;
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const chunks: Blob[] = [];
      const r = new MediaRecorder(s);
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        setBlob(new Blob(chunks, { type: r.mimeType }));
        setState('done');
        void ctx.close();
        cleanup();
      };
      rec.current = r;
      r.start();
      setState('recording');
      const t0 = performance.now();
      const loop = () => {
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
        setLevel(Math.max(0, Math.min(100, (20 * Math.log10(rms + 1e-9) + 60) * (100 / 60))));
        const sec = (performance.now() - t0) / 1000;
        setElapsed(sec);
        if (sec >= MAX_SEC) r.state === 'recording' && r.stop();
        else raf.current = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      setState('error');
    }
  };

  const stop = () => rec.current?.state === 'recording' && rec.current.stop();
  const use = () => {
    if (!blob) return;
    const name = `recording-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.webm`;
    const file = new File([blob], name, { type: blob.type });
    onDone({ path: name, name, size: file.size, file });
  };

  return (
    <Modal title={t('recorder.title')} onClose={() => { stop(); onClose(); }} footer={
      state === 'done' ? (
        <>
          <Btn variant="ghost" onClick={() => { setBlob(null); setElapsed(0); setState('idle'); }}>{t('recorder.again')}</Btn>
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
      <div className="flex items-center gap-3 font-mono text-[11px]">
        <span className="w-10 text-mute">IN</span>
        <Segs level={state === 'recording' ? level : 0} />
        <span className="w-16 text-right">{elapsed.toFixed(1)}s / {MAX_SEC}s</span>
      </div>
      {state === 'done' && elapsed < MIN_SEC && <Alert title={t('recorder.tooShort', { min: MIN_SEC })} />}
      {state === 'error' && <Alert title={t('recorder.noMic')}>{t('recorder.noMicBody')}</Alert>}
    </Modal>
  );
}
