import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { FileRef, ImportInspection } from '../../api/types';
import { Alert, Btn, Check, DropZone, KvRows, Panel, TextInput } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { platform } from '../../lib/platform';
import { useUi } from '../../stores/ui';

export function ImportPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  const [scanning, setScanning] = useState(false);
  const [ins, setIns] = useState<ImportInspection | null>(null);
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const inspect = async (files: FileRef[]) => {
    if (!files.length) return;
    setScanning(true);
    setError('');
    try {
      const r = await engine().inspectImport(files);
      setIns(r);
      setName(r.suggestedName);
      setAgree(false);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setScanning(false);
    }
  };
  const pick = async (kind: 'evoice' | 'rvc') => inspect(await platform.pickFiles(
    kind === 'evoice'
      ? { title: t('import.chooseEvoice'), filters: [{ name: 'EasyVoice', extensions: ['evoice'] }] }
      : { title: t('import.chooseRvc'), multiple: true, filters: [{ name: 'RVC', extensions: ['pth', 'index'] }] },
  ));

  const submit = async () => {
    if (!ins) return;
    setBusy(true);
    try {
      await engine().importVoice(ins.token, name.trim());
      toast(t('import.done', { name: name.trim() }));
      onClose();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const licenseText = ins ? t(`license.${ins.license}`) : '';
  return (
    <Panel title="IMPORT_VOICE" label={t('import.aria')} onClose={onClose}>
      <div className="p-5 flex flex-col gap-5">
        {!ins ? (
          <DropZone caption=".EVOICE · OR · RVC .PTH + .INDEX" text={scanning ? t('import.scanning') : t('import.drop')}
            onFiles={(f) => void inspect(f.map((x) => ({ path: x.name, name: x.name, size: x.size, file: x })))}>
            <Btn variant="outline" disabled={scanning} onClick={() => void pick('evoice')}>{t('import.chooseEvoice')}</Btn>
            <Btn variant="ghost" disabled={scanning} onClick={() => void pick('rvc')}>{t('import.chooseRvc')}</Btn>
            {engine().mode === 'mock' && (
              <Btn variant="dashed" disabled={scanning} onClick={() => void inspect([{ path: 'free_voice_pack.pth', name: 'free_voice_pack.pth', size: 61e6 }])}>
                {t('import.unsafeDemo')}
              </Btn>
            )}
          </DropZone>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex justify-between items-center flex-wrap gap-2 font-mono text-[12px]">
              <span>{ins.fileLabel}</span>
              <Btn variant="link" onClick={() => setIns(null)}>[{t('common.replace')}]</Btn>
            </div>
            <KvRows title={t('import.scan')} rows={ins.checks.map((c) => ({ k: t(`import.check.${c.key}`), v: c.value, bad: c.bad }))} />
            {ins.blocked ? (
              <Alert title={t('import.blockedTitle')}>{t('import.blockedBody')}</Alert>
            ) : (
              <div className="flex flex-col gap-5">
                <div className="border border-line grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
                  {[
                    [t('import.meta.author'), ins.author === 'unknown' ? t('common.unknown') : ins.author],
                    [t('import.meta.language'), t(`lang.${ins.language}`)],
                    [t('import.meta.includes'), ins.capabilities.map((c) => t(`import.cap.${c}`)).join(' + ')],
                    [t('import.meta.license'), licenseText],
                    [t('import.meta.source'), ins.kind === 'evoice' ? ins.createdAt ?? '—' : t('import.rawRvc')],
                    [t('import.meta.sampleRate'), `${ins.sampleRate / 1000} kHz`],
                  ].map(([k, v]) => (
                    <div key={k} className="px-3 py-2.5 border-b border-r border-line2">
                      <div className="font-mono text-[11px] tracking-label text-mute uppercase">{k}</div>
                      <div className="font-semibold">{v}</div>
                    </div>
                  ))}
                </div>
                <TextInput label={t('import.name')} value={name} onChange={setName} />
                <Check id="impagree" checked={agree} onChange={setAgree} boxed>{t('import.agree', { license: licenseText })}</Check>
                <div className="flex justify-end">
                  <Btn variant="primary" disabled={!agree || !name.trim() || busy} onClick={() => void submit()}>
                    {busy ? t('common.working') : `↓ ${t('import.submit')}`}
                  </Btn>
                </div>
              </div>
            )}
          </div>
        )}
        {error && <Alert title={error} />}
      </div>
    </Panel>
  );
}
