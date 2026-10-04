// Hướng dẫn cài thiết bị âm thanh ảo (spec 3.4: không bundle driver trong v1, chỉ hướng dẫn + link chính thức).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Btn, Modal, Segmented } from '../../components/ui';
import { osName, platform } from '../../lib/platform';

const LINKS = {
  windows: { name: 'VB-Cable', url: 'https://vb-audio.com/Cable/' },
  mac: { name: 'BlackHole', url: 'https://existential.audio/blackhole/' },
};

export function VirtualDeviceGuide({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [os, setOs] = useState<'windows' | 'mac'>(osName() === 'mac' ? 'mac' : 'windows');
  const steps = t(`guide.${os}.steps`, { returnObjects: true }) as string[];
  return (
    <Modal title={t('guide.title')} onClose={onClose} width={600} footer={
      <>
        <Btn variant="ghost" onClick={() => void platform.openExternal(LINKS[os].url)}>{t('guide.open', { name: LINKS[os].name })} ↗</Btn>
        <Btn variant="inverse" onClick={onClose}>{t('common.done')}</Btn>
      </>
    }>
      <Segmented value={os} onChange={setOs} options={[{ id: 'windows', label: 'Windows · VB-Cable' }, { id: 'mac', label: 'macOS · BlackHole' }]} />
      <ol className="m-0 pl-0 list-none flex flex-col border border-line">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3 px-3.5 py-3 border-b border-line2 last:border-b-0">
            <span className="font-mono text-[11px] text-acc pt-0.5">{String(i + 1).padStart(2, '0')}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="m-0 text-[12px] text-mute">{t('guide.note')}</p>
    </Modal>
  );
}
