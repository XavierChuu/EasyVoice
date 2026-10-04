// Từ điển phát âm riêng của người dùng (spec 3.2): thay chữ/viết tắt trước khi đưa vào model.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DictEntry } from '../../api/types';
import { Btn, Modal } from '../../components/ui';
import { useSettings } from '../../stores/settings';

const inputCls = 'bg-bg border border-line3 px-3 py-2 text-fg rounded-none min-w-0 flex-1';

export function DictionaryModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const saved = useSettings((s) => s.dict);
  const set = useSettings((s) => s.set);
  const [rows, setRows] = useState<DictEntry[]>(saved.length ? saved : [{ from: '', to: '' }]);

  const update = (i: number, patch: Partial<DictEntry>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = () => {
    set({ dict: rows.map((r) => ({ from: r.from.trim(), to: r.to.trim() })).filter((r) => r.from && r.to) });
    onClose();
  };

  return (
    <Modal title={t('dict.title')} onClose={onClose} width={620} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn variant="primary" onClick={save}>{t('common.save')}</Btn>
      </>
    }>
      <p className="m-0 text-soft">{t('dict.desc')}</p>
      <div className="flex font-mono text-[11px] tracking-label text-mute gap-2 pr-10">
        <span className="flex-1">{t('dict.from')}</span>
        <span className="flex-1">{t('dict.to')}</span>
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input className={inputCls} value={r.from} placeholder="AI" onChange={(e) => update(i, { from: e.target.value })} aria-label={t('dict.from')} />
            <input className={inputCls} value={r.to} placeholder={t('dict.toPlaceholder')} onChange={(e) => update(i, { to: e.target.value })} aria-label={t('dict.to')} />
            <button type="button" aria-label={t('common.remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))}
              className="bg-transparent border-0 text-mute hover:text-acc cursor-pointer w-8 h-8">×</button>
          </div>
        ))}
      </div>
      <div>
        <Btn variant="link" onClick={() => setRows([...rows, { from: '', to: '' }])}>[+ {t('dict.add')}]</Btn>
      </div>
    </Modal>
  );
}
