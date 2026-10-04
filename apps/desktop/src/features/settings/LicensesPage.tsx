import { useTranslation } from 'react-i18next';

import { PageHead } from '../../components/ui';
import { useEngine } from '../../stores/engine';

export function LicensesPage() {
  const { t } = useTranslation();
  const models = useEngine((s) => s.system?.models ?? []);
  const nc = models.some((m) => m.commercial === false);
  const th = 'text-left font-normal px-3 py-2 border-b border-line text-mute text-[11px] tracking-label';
  return (
    <div className="flex flex-col gap-7">
      <PageHead code={t('licenses.code')} title={t('licenses.title')} desc={t('licenses.desc')} />
      {nc && (
        <div className="border border-acc px-3.5 py-3 flex gap-3">
          <span className="font-mono font-bold text-acc">[!]</span>
          <span className="text-soft">{t('licenses.ncWarn')}</span>
        </div>
      )}
      <div className="border border-line overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              <th className={th}>{t('licenses.model')}</th>
              <th className={th}>{t('licenses.role')}</th>
              <th className={th}>{t('licenses.license')}</th>
              <th className={th}>{t('licenses.commercial')}</th>
              <th className={`${th} text-right`}>{t('licenses.size')}</th>
              <th className={`${th} text-right`}>{t('licenses.installed')}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} className="border-b border-line2 last:border-b-0">
                <td className="px-3 py-2.5 font-sans text-[14px] font-semibold">{m.name}</td>
                <td className="px-3 py-2.5 text-mute">{m.role}</td>
                <td className="px-3 py-2.5">{m.license}</td>
                <td className={`px-3 py-2.5 ${m.commercial === false ? 'text-acc' : ''}`}>{m.commercial === null ? '?' : m.commercial ? t('common.yes') : t('common.no')}</td>
                <td className="px-3 py-2.5 text-right">{m.sizeMb >= 1000 ? `${(m.sizeMb / 1000).toFixed(1)} GB` : `${m.sizeMb} MB`}</td>
                <td className="px-3 py-2.5 text-right">{m.installed ? <span className="text-acc">OK</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 text-mute text-[13px]">{t('licenses.appNote')}</p>
    </div>
  );
}
