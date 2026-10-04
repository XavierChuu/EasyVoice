import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { Profile } from '../../api/types';
import { Btn, ConfirmModal, Modal, PageHead, TextInput } from '../../components/ui';
import { useEngine } from '../../stores/engine';
import { useSts } from '../../stores/sts';
import { useTts } from '../../stores/tts';
import { useUi } from '../../stores/ui';
import { ExportPanel } from './ExportPanel';
import { ImportPanel } from './ImportPanel';
import { NewVoiceWizard } from './NewVoiceWizard';
import { TrainingPanel } from './TrainingPanel';
import { VoiceCard } from './VoiceCard';

type PanelState = { kind: 'none' } | { kind: 'wizard' } | { kind: 'import' } | { kind: 'export'; id: string } | { kind: 'training'; id: string };

export function VoicesPage() {
  const { t } = useTranslation();
  const voices = useEngine((s) => s.voices);
  const jobs = useEngine((s) => s.jobs);
  const setTab = useUi((s) => s.setTab);
  const toast = useUi((s) => s.toast);
  const [panel, setPanel] = useState<PanelState>({ kind: 'none' });
  const [renaming, setRenaming] = useState<{ p: Profile; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);

  const find = (id: string) => voices.find((v) => v.id === id);
  const exportP = panel.kind === 'export' ? find(panel.id) : undefined;
  const trainP = panel.kind === 'training' ? find(panel.id) : undefined;
  const trainJob = trainP?.trainJobId ? jobs[trainP.trainJobId] : undefined;
  const close = () => setPanel({ kind: 'none' });

  return (
    <div className="flex flex-col gap-7">
      <PageHead code={t('voices.code')} title={t('voices.title')} desc={t('voices.desc')}>
        <div className="flex gap-2 flex-wrap">
          <Btn variant="outline" className="!font-mono !font-bold !text-[12px] tracking-label px-5" onClick={() => setPanel({ kind: 'import' })}>↓ {t('voices.import')}</Btn>
          <Btn variant="primary" onClick={() => setPanel({ kind: 'wizard' })}>+ {t('voices.new')}</Btn>
        </div>
      </PageHead>

      {panel.kind === 'import' && <ImportPanel onClose={close} />}
      {panel.kind === 'wizard' && <NewVoiceWizard onClose={close} />}
      {exportP && <ExportPanel key={exportP.id} profile={exportP} onClose={close} />}
      {trainP && trainJob && <TrainingPanel profile={trainP} job={trainJob} onClose={close} />}

      {voices.length === 0 ? (
        <div className="border border-dashed border-line3 stripes p-10 text-center flex flex-col gap-3 items-center">
          <span className="font-mono text-[11px] tracking-label text-mute">{t('voices.emptyCaption')}</span>
          <div>{t('voices.empty')}</div>
          <Btn variant="primary" onClick={() => setPanel({ kind: 'wizard' })}>+ {t('voices.new')}</Btn>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {voices.map((p, i) => (
            <VoiceCard
              key={p.id}
              profile={p}
              code={`VOX-${String(voices.length - i).padStart(3, '0')}`}
              job={p.trainJobId ? jobs[p.trainJobId] : undefined}
              onRead={() => { useTts.getState().set({ profileId: p.id, mode: 'direct' }); setTab('tts'); }}
              onConvert={() => { useSts.getState().set({ profileId: p.id }); setTab('sts'); }}
              onExport={() => setPanel({ kind: 'export', id: p.id })}
              onRename={() => setRenaming({ p, name: p.name })}
              onDelete={() => setDeleting(p)}
              onTraining={() => setPanel({ kind: 'training', id: p.id })}
            />
          ))}
        </div>
      )}

      {renaming && (
        <Modal title={t('voices.renameTitle')} onClose={() => setRenaming(null)} footer={
          <>
            <Btn variant="ghost" onClick={() => setRenaming(null)}>{t('common.cancel')}</Btn>
            <Btn variant="primary" disabled={!renaming.name.trim()} onClick={() => {
              void engine().renameVoice(renaming.p.id, renaming.name.trim());
              setRenaming(null);
            }}>{t('common.save')}</Btn>
          </>
        }>
          <TextInput label={t('wizard.name')} value={renaming.name} onChange={(name) => setRenaming({ ...renaming, name })} autoFocus />
        </Modal>
      )}
      {deleting && (
        <ConfirmModal
          title={t('voices.deleteTitle')}
          body={deleting.trainJobId ? t('voices.deleteBodyTraining', { name: deleting.name }) : t('voices.deleteBody', { name: deleting.name })}
          confirmLabel={t('voices.delete')}
          danger
          onConfirm={() => {
            void engine().deleteVoice(deleting.id);
            if (panel.kind !== 'none' && 'id' in panel && panel.id === deleting.id) close();
            toast(t('voices.deleted', { name: deleting.name }));
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
