import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { ExportOptions, Profile } from '../../api/types';
import { Alert, Btn, Check, Label, Panel, Segmented, TextInput } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { platform } from '../../lib/platform';
import { slugify } from '../../lib/text';
import { canSts } from '../../stores/engine';
import { useSettings } from '../../stores/settings';

export function ExportPanel({ profile: p, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useTranslation();
  const savedAuthor = useSettings((s) => s.author);
  const setSettings = useSettings((s) => s.set);
  const hasModel = canSts(p);
  // spec 3.5: giọng nhập từ người khác không được kèm audio mẫu khi xuất lại
  const hasRef = p.hasRef && !p.imported;
  const [incModel, setIncModel] = useState(hasModel);
  const [incRef, setIncRef] = useState(false);
  const [license, setLicense] = useState<ExportOptions['license']>('personal');
  const [author, setAuthor] = useState(savedAuthor);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ path: string; sizeMb: number } | null>(null);
  const [error, setError] = useState('');

  const m = incModel && hasModel;
  const r = incRef && hasRef;
  const size = engine().estimateExport(p.id, { includeModel: m, includeRef: r });
  const file = `${slugify(p.name)}.evoice`;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      setDone(await engine().exportVoice(p.id, { includeModel: m, includeRef: r, license, author: author.trim() }));
      if (author.trim()) setSettings({ author: author.trim() });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={`EXPORT_VOICE · ${p.name.toUpperCase()}`} label={t('export.aria')} onClose={onClose}>
      {!done ? (
        <div className="p-5 flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label>{t('export.include')}</Label>
            <div className="border border-line">
              <div className="p-3 border-b border-line2">
                <Check id="exm" checked={m} disabled={!hasModel} onChange={setIncModel}
                  sub={hasModel ? t('export.modelNote') : t('export.noModel')}>{t('export.model')}</Check>
              </div>
              <div className="p-3">
                <Check id="exr" checked={r} disabled={!hasRef} onChange={setIncRef} subTone={r ? 'acc' : 'mute'}
                  sub={!hasRef ? (p.imported ? t('export.refImported') : t('export.refNone')) : r ? t('export.refOn') : t('export.refOff')}>
                  {t('export.ref')}
                </Check>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t('export.license')}</Label>
            <Segmented value={license} onChange={setLicense} options={(['personal', 'commercial', 'noredist'] as const).map((id) => ({
              id, label: t(`export.lic.${id}.title`), desc: t(`export.lic.${id}.desc`),
            }))} />
          </div>
          <TextInput label={t('export.author')} value={author} onChange={setAuthor} placeholder={t('export.authorPlaceholder')} />
          {error && <Alert title={error} />}
          <div className="flex justify-between items-center flex-wrap gap-4 border-t border-line pt-4">
            <span className="font-mono text-[11px] text-mute">{file} · {size.toFixed(1)} MB · EVOICE v1 · SAFETENSORS</span>
            <Btn variant="primary" disabled={!(m || r) || busy} onClick={() => void submit()}>
              {busy ? t('common.working') : `↑ ${t('export.submit')}`}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="p-5 flex flex-col gap-4">
          <div className="font-mono text-[12px] break-all"><span className="text-acc">SAVED</span> {done.path} · {done.sizeMb.toFixed(1)} MB</div>
          <div className="text-soft">{t('export.doneBody')}</div>
          <div className="flex gap-2 flex-wrap justify-end">
            <Btn variant="ghost" onClick={() => void platform.showInFolder(done.path)}>{t('common.showInFolder')}</Btn>
            <Btn variant="inverse" onClick={onClose}>{t('common.done')}</Btn>
          </div>
        </div>
      )}
    </Panel>
  );
}
