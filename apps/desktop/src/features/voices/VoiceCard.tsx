import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../api/engine';
import type { Job, Profile } from '../../api/types';
import { Icon, ICONS } from '../../components/ui';
import { variantLabel } from './VariantEditor';
import { pad2 } from '../../lib/text';
import { tagLabels } from '../../lib/voiceTags';
import { canSts, canTts } from '../../stores/engine';
import { usePlayer } from '../../stores/player';
import { useSettings } from '../../stores/settings';

export function createdLabel(iso: string, today: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return today;
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

interface Props {
  profile: Profile;
  code: string;
  job?: Job;
  onRead: () => void;
  onConvert: () => void;
  onExport: () => void;
  onRename: () => void;
  onDelete: () => void;
  onTraining: () => void;
  onAddVariant: () => void;
  onDeleteVariant: (variantId: string, name: string) => void;
}

export function VoiceCard({ profile: p, code, job, onRead, onConvert, onExport, onRename, onDelete, onTraining, onAddVariant, onDeleteVariant }: Props) {
  const { t } = useTranslation();
  const player = usePlayer();
  const uiLang = useSettings((s) => s.lang);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const playing = player.key === `voice:${p.id}`;
  const training = !!p.trainJobId;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const togglePlay = async () => {
    if (playing) return player.stop();
    player.play(`voice:${p.id}`, await engine().previewVoice(p.id));
  };
  const toggleVariant = async (vid: string) => {
    const key = `voice:${p.id}:${vid}`;
    if (player.key === key) return player.stop();
    player.play(key, await engine().previewVoice(p.id, vid));
  };

  let stageLine: { left: string; right: string } | null = null;
  if (job && training) {
    if (job.status === 'queued') stageLine = { left: t('training.queued'), right: `${(job.progress * 100).toFixed(1)}%` };
    else if (job.status === 'paused') stageLine = { left: t('training.paused'), right: `${(job.progress * 100).toFixed(1)}%` };
    else if (job.status === 'failed') stageLine = { left: t('training.failed'), right: '' };
    else stageLine = { left: t(`training.stage.${job.stage ?? 'preprocess'}`), right: `${(job.progress * 100).toFixed(1)}%` };
  }

  const sub = [t(`lang.${p.language}`), p.imported && p.author ? t('voices.importedBy', { author: p.author }) : null]
    .filter(Boolean).join(' · ');
  const tg = tagLabels(t, p, uiLang);
  const tags = [tg.gender, tg.country, tg.region].filter(Boolean);
  const badge = (on: boolean, label: string) => on
    ? <span className="px-2 py-0.5 bg-fg text-bg font-bold">{label}</span>
    : <span className="px-[7px] py-px border border-line3 text-mute">{label} —</span>;
  const actionCls = 'flex-1 bg-transparent text-fg border-0 border-r border-line p-2.5 cursor-pointer min-h-[44px] text-[13px] font-semibold hover:bg-line2';

  return (
    <article className="border border-line flex flex-col">
      <div className="flex justify-between items-center pl-3.5 pr-1 border-b border-line font-mono text-[11px] text-mute tracking-[.06em]">
        <span>{code}</span>
        <div className="flex items-center gap-1 relative" ref={menuRef}>
          <span>{createdLabel(p.createdAt, t('voices.today'))}</span>
          <button type="button" aria-label={t('voices.menu')} aria-expanded={menu} onClick={() => setMenu(!menu)}
            className="bg-transparent border-0 text-mute hover:text-fg cursor-pointer w-8 h-8 inline-flex items-center justify-center">
            <Icon d={ICONS.more} size={16} stroke={3} />
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 top-8 z-20 bg-bg border border-fg min-w-[180px] flex flex-col font-sans text-[13px] tracking-normal">
              <MenuItem onClick={() => { setMenu(false); onRename(); }}>{t('voices.rename')}</MenuItem>
              {canTts(p) && !training && <MenuItem onClick={() => { setMenu(false); onAddVariant(); }}>{t('variants.add')}</MenuItem>}
              {job && <MenuItem onClick={() => { setMenu(false); onTraining(); }}>{t('voices.viewTraining')}</MenuItem>}
              <MenuItem onClick={() => { setMenu(false); onDelete(); }} danger>{t('voices.delete')}</MenuItem>
            </div>
          )}
        </div>
      </div>
      <div className="px-3.5 py-4 flex flex-col gap-3">
        <div>
          <div className="font-bold text-[18px] leading-[1.2] break-words">{p.name}</div>
          <div className="text-[12px] text-mute">{sub}</div>
        </div>
        {tags.length > 0 && (
          <div className="flex gap-1.5 flex-wrap text-[12px]">
            {tags.map((x) => <span key={x} className="px-2 py-0.5 bg-line2 text-soft">{x}</span>)}
          </div>
        )}
        <div className="flex gap-1.5 flex-wrap font-mono text-[11px]">
          {badge(canTts(p), 'TTS')}
          {badge(canSts(p), 'STS')}
        </div>
        {canTts(p) && (
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] tracking-label text-mute">{t('variants.section')}</span>
            <div className="flex gap-1.5 flex-wrap font-mono text-[11px]">
              <span className="px-2 py-1 border border-fg">{t('variants.standard')}</span>
              {p.variants.map((v) => {
                const on = player.key === `voice:${p.id}:${v.id}`;
                return (
                  <span key={v.id} className={`group inline-flex items-stretch border ${on ? 'border-acc bg-acc text-bg' : 'border-line3'}`}>
                    <button type="button" onClick={() => void toggleVariant(v.id)} aria-label={`${t('common.play')} ${variantLabel(t, v)}`}
                      className="bg-transparent border-0 text-inherit px-2 py-1 cursor-pointer font-mono text-[11px] hover:text-acc">
                      {on ? '■' : '▶'} {variantLabel(t, v)}
                    </button>
                    <button type="button" onClick={() => onDeleteVariant(v.id, variantLabel(t, v))} aria-label={`${t('voices.delete')} ${variantLabel(t, v)}`}
                      className="bg-transparent border-0 border-l border-line3 text-mute px-1.5 cursor-pointer hover:text-acc opacity-60 group-hover:opacity-100">×</button>
                  </span>
                );
              })}
              {!training && (
                <button type="button" onClick={onAddVariant}
                  className="bg-transparent border border-dashed border-line3 text-acc px-2 py-1 cursor-pointer font-mono text-[11px] hover:border-acc">
                  + {t('variants.short')}
                </button>
              )}
            </div>
          </div>
        )}
        {stageLine && job && (
          <button type="button" onClick={onTraining} className="flex flex-col gap-1.5 font-mono text-[11px] bg-transparent border-0 p-0 text-fg text-left cursor-pointer">
            <div className="flex justify-between w-full"><span className="text-acc">{stageLine.left}</span><span>{stageLine.right}</span></div>
            <div className="h-1 bg-line w-full"><div className="h-1 bg-acc" style={{ width: `${job.progress * 100}%` }} /></div>
            {job.status === 'queued' && job.waitingFor && <span className="text-mute">{t('training.waitingFor', { name: job.waitingFor })}</span>}
          </button>
        )}
      </div>
      <div className="flex border-t border-line mt-auto">
        <button type="button" onClick={() => void togglePlay()} disabled={!p.hasRef} title={p.hasRef ? undefined : t('voices.noPreview')}
          className={`${actionCls} ${playing ? '!bg-acc !text-bg' : ''}`}>
          {playing ? `■ ${t('common.stop')}` : `▶ ${t('common.play')}`}
        </button>
        <button type="button" onClick={onRead} disabled={!canTts(p)} className={actionCls}>{t('voices.read')}</button>
        <button type="button" onClick={onConvert} disabled={!canSts(p)} className={actionCls}>{t('voices.convert')}</button>
        <button type="button" onClick={onExport} disabled={training} aria-label={t('voices.export')}
          className="flex-[0_0_48px] bg-transparent text-fg border-0 p-2.5 cursor-pointer min-h-[44px] inline-flex items-center justify-center hover:bg-line2">
          <Icon d={ICONS.export} />
        </button>
      </div>
    </article>
  );
}

function MenuItem({ children, onClick, danger }: { children: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      className={`text-left bg-transparent border-0 border-b border-line2 last:border-b-0 px-3.5 py-2.5 cursor-pointer hover:bg-fg hover:text-bg ${danger ? 'text-acc' : 'text-fg'}`}>
      {children}
    </button>
  );
}
