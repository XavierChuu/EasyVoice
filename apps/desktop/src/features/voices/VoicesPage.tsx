import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { Profile, VoiceTags } from '../../api/types';
import { Btn, ConfirmModal, Modal, PageHead, TextInput } from '../../components/ui';
import { EMPTY_FILTER, matchVoice, tagLabels, type VoiceFilter } from '../../lib/voiceTags';
import { useSettings } from '../../stores/settings';
import { useEngine } from '../../stores/engine';
import { useSts } from '../../stores/sts';
import { useTts } from '../../stores/tts';
import { useUi } from '../../stores/ui';
import { ExportPanel } from './ExportPanel';
import { ImportPanel } from './ImportPanel';
import { NewVoiceWizard } from './NewVoiceWizard';
import { TagFields } from './TagFields';
import { TrainingPanel } from './TrainingPanel';
import { variantLabel } from './VariantEditor';
import { VariantPanel } from './VariantPanel';
import { VoiceCard } from './VoiceCard';
import { VoiceFilters, type VoiceSort } from './VoiceFilters';

type PanelState = { kind: 'none' } | { kind: 'wizard' } | { kind: 'import' } | { kind: 'export'; id: string } | { kind: 'training'; id: string }
  | { kind: 'variant'; id: string };

export function VoicesPage() {
  const { t } = useTranslation();
  const voices = useEngine((s) => s.voices);
  const jobs = useEngine((s) => s.jobs);
  const setTab = useUi((s) => s.setTab);
  const toast = useUi((s) => s.toast);
  const [panel, setPanel] = useState<PanelState>({ kind: 'none' });
  const uiLang = useSettings((s) => s.lang);
  const [editing, setEditing] = useState<{ p: Profile; name: string; tags: VoiceTags } | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [deletingVariant, setDeletingVariant] = useState<{ p: Profile; id: string; name: string } | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VoiceFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<VoiceSort>('newest');

  // Tìm (không dấu) theo tên, biến thể, ngôn ngữ, giới tính, quốc gia, vùng miền; lọc theo thẻ; sắp xếp.
  const shown = useMemo(() => {
    const words = (p: Profile) => {
      const tg = tagLabels(t, p, uiLang);
      return [p.name, t(`lang.${p.language}`), tg.gender, tg.country, p.country ?? '', tg.region, ...p.variants.map((v) => variantLabel(t, v))];
    };
    const list = voices.filter((p) => matchVoice(p, filter, query, words));
    if (sort === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name, uiLang));
    if (sort === 'oldest') return [...list].reverse();
    return list;
  }, [voices, query, filter, sort, t, uiLang]);

  const find = (id: string) => voices.find((v) => v.id === id);
  const exportP = panel.kind === 'export' ? find(panel.id) : undefined;
  const trainP = panel.kind === 'training' ? find(panel.id) : undefined;
  const variantP = panel.kind === 'variant' ? find(panel.id) : undefined;
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
      {variantP && <VariantPanel key={variantP.id} profile={variantP} onClose={close} />}

      {voices.length > 0 && (
        <VoiceFilters voices={voices} query={query} onQuery={setQuery} filter={filter} onFilter={setFilter}
          sort={sort} onSort={setSort} shown={shown.length} />
      )}

      {voices.length === 0 ? (
        <div className="border border-dashed border-line3 stripes p-10 text-center flex flex-col gap-3 items-center">
          <span className="font-mono text-[11px] tracking-label text-mute">{t('voices.emptyCaption')}</span>
          <div>{t('voices.empty')}</div>
          <Btn variant="primary" onClick={() => setPanel({ kind: 'wizard' })}>+ {t('voices.new')}</Btn>
        </div>
      ) : shown.length === 0 ? (
        <div className="border border-dashed border-line3 p-8 text-center text-mute flex flex-col gap-2 items-center">
          {query.trim() ? t('voices.noMatch', { query: query.trim() }) : t('voices.noMatchFilter')}
          <Btn variant="link" onClick={() => { setQuery(''); setFilter(EMPTY_FILTER); }}>[{t('voices.clearFilters')}]</Btn>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {shown.map((p) => (
            <VoiceCard
              key={p.id}
              profile={p}
              code={`VOX-${String(voices.length - voices.indexOf(p)).padStart(3, '0')}`}
              job={p.trainJobId ? jobs[p.trainJobId] : undefined}
              onRead={() => { useTts.getState().set({ profileId: p.id, mode: 'direct' }); setTab('tts'); }}
              onConvert={() => { useSts.getState().set({ profileId: p.id }); setTab('sts'); }}
              onExport={() => setPanel({ kind: 'export', id: p.id })}
              onRename={() => setEditing({ p, name: p.name, tags: { gender: p.gender, country: p.country, region: p.region } })}
              onDelete={() => setDeleting(p)}
              onTraining={() => setPanel({ kind: 'training', id: p.id })}
              onAddVariant={() => setPanel({ kind: 'variant', id: p.id })}
              onDeleteVariant={(id, name) => setDeletingVariant({ p, id, name })}
            />
          ))}
        </div>
      )}

      {editing && (
        <Modal title={t('voices.renameTitle')} width={640} onClose={() => setEditing(null)} footer={
          <>
            <Btn variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Btn>
            <Btn variant="primary" disabled={!editing.name.trim()} onClick={() => {
              void engine().updateVoice(editing.p.id, { name: editing.name.trim(), ...editing.tags });
              setEditing(null);
            }}>{t('common.save')}</Btn>
          </>
        }>
          <TextInput label={t('wizard.name')} value={editing.name} onChange={(name) => setEditing({ ...editing, name })} autoFocus />
          <TagFields id="edit" value={editing.tags} onChange={(tags) => setEditing({ ...editing, tags })} />
        </Modal>
      )}
      {deletingVariant && (
        <ConfirmModal
          title={t('variants.deleteTitle')}
          body={t('variants.deleteBody', { name: deletingVariant.name, voice: deletingVariant.p.name })}
          confirmLabel={t('voices.delete')}
          danger
          onConfirm={() => {
            void engine().deleteVariant(deletingVariant.p.id, deletingVariant.id);
            toast(t('variants.deleted', { name: deletingVariant.name }));
          }}
          onClose={() => setDeletingVariant(null)}
        />
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
