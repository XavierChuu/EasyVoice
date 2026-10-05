// Bộ component cơ bản theo đúng ngôn ngữ thiết kế của UI mẫu (viền 1px, góc vuông, mono label, cam #FF5B14).
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const selCls = (on: boolean) => (on ? 'bg-fg text-bg' : 'bg-transparent text-fg');

// ---------- Icons ----------
export function Icon({ d, size = 16, stroke = 1.8, className }: { d: string; size?: number; stroke?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="square" strokeLinejoin="miter" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const ICONS = {
  close: 'M6 6l12 12M18 6L6 18',
  voices: 'M12 3v12M8 7v5a4 4 0 0 0 8 0V7M5 11a7 7 0 0 0 14 0M12 18v3',
  tts: 'M4 6h16M4 11h16M4 16h10',
  sts: 'M4 8h14l-4-4M20 16H6l4 4',
  edit: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  licenses: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  export: 'M12 15V3M7 8l5-5 5 5M4 14v6h16v-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  logo: 'M4 10v4M8 7v10M12 4v20M16 7v10M20 10v4',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  folder: 'M3 6h6l2 2h10v11H3z',
};

// ---------- Text ----------
export function Label({ children, className, htmlFor }: { children: ReactNode; className?: string; htmlFor?: string }) {
  const cls = cx('font-mono text-[11px] tracking-label text-mute uppercase', className);
  return htmlFor ? <label htmlFor={htmlFor} className={cls}>{children}</label> : <span className={cls}>{children}</span>;
}

export function PageHead({ code, title, desc, children }: { code: string; title: string; desc: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-4 items-end justify-between border-b border-line pb-5">
      <div>
        <div className="font-mono text-[11px] tracking-wide2 text-acc">{code}</div>
        <h1 className="mt-1.5 mb-0 text-[36px] font-bold leading-[1.1]">{title}</h1>
        <p className="mt-1.5 mb-0 text-mute">{desc}</p>
      </div>
      {children}
    </div>
  );
}

// ---------- Buttons ----------
type BtnVariant = 'primary' | 'outline' | 'ghost' | 'dashed' | 'inverse' | 'link' | 'bare';

const BTN: Record<BtnVariant, string> = {
  primary: 'bg-acc text-bg border-0 px-5 py-3 font-mono font-bold text-[12px] tracking-label min-h-[44px] hover:bg-acc2',
  outline: 'bg-transparent text-fg border border-fg px-4 py-2.5 font-semibold min-h-[44px] hover:bg-fg hover:text-bg',
  ghost: 'bg-transparent text-fg border border-line3 px-4 py-2.5 font-semibold min-h-[44px] hover:border-fg',
  dashed: 'bg-transparent text-mute border border-dashed border-line3 px-4 py-2.5 font-semibold min-h-[44px]',
  inverse: 'bg-fg text-bg border-0 px-5 py-3 font-mono font-bold text-[12px] tracking-label min-h-[44px]',
  link: 'bg-transparent border-0 text-acc min-h-[32px] font-mono text-[12px] hover:text-acc2',
  bare: 'bg-transparent border-0 text-fg',
};

export function Btn({ variant = 'outline', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return <button type="button" className={cx('cursor-pointer', BTN[variant], className)} {...rest} />;
}

export function CloseBtn({ onClick, label }: { onClick: () => void; label?: string }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onClick} aria-label={label ?? t('common.close')}
      className="bg-transparent border-0 text-fg cursor-pointer min-w-[44px] min-h-[44px] inline-flex items-center justify-center hover:text-acc">
      <Icon d={ICONS.close} size={16} stroke={2} />
    </button>
  );
}

// ---------- Containers ----------
export function Panel({ title, onClose, children, label }: { title: string; onClose?: () => void; children: ReactNode; label?: string }) {
  return (
    <section aria-label={label ?? title} className="border border-fg flex flex-col">
      <div className="flex justify-between items-center py-2 pr-2 pl-5 border-b border-line min-h-[44px]">
        <h2 className="m-0 font-mono text-[12px] tracking-wide2 font-bold">{title}</h2>
        {onClose && <CloseBtn onClick={onClose} />}
      </div>
      {children}
    </section>
  );
}

export function Box({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('border border-line flex flex-col min-w-0', className)}>
      {title !== undefined && (
        <div className="flex justify-between gap-3 px-3.5 py-2 border-b border-line font-mono text-[11px] tracking-[.08em] text-mute">
          <span>{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function KvRows({ rows, title }: { rows: { k: string; v: ReactNode; bad?: boolean }[]; title?: string }) {
  return (
    <div className="border border-line font-mono text-[12px]">
      {title && <div className="px-3 py-2 border-b border-line text-mute text-[11px] tracking-label">{title}</div>}
      {rows.map((r) => (
        <div key={r.k} className="flex justify-between gap-3 px-3 py-[9px] border-b border-line2 last:border-b-0">
          <span className="text-mute">{r.k}</span>
          <span className={cx('text-right', r.bad ? 'text-acc' : 'text-fg')}>{r.v}</span>
        </div>
      ))}
    </div>
  );
}

export function DropZone({ caption, text, children, onFiles, pad = 'p-7' }: {
  caption: string; text: string; children: ReactNode; onFiles?: (files: File[]) => void; pad?: string;
}) {
  return (
    <div
      className={cx('stripes border border-dashed border-line3 flex flex-col items-center gap-3 text-center', pad)}
      onDragOver={(e) => { if (onFiles) e.preventDefault(); }}
      onDrop={(e) => {
        if (!onFiles) return;
        e.preventDefault();
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <span className="font-mono text-[11px] tracking-label text-mute">{caption}</span>
      <div>{text}</div>
      <div className="flex gap-2 flex-wrap justify-center">{children}</div>
    </div>
  );
}

export function Alert({ title, children, tone = 'acc', action }: { title?: string; children?: ReactNode; tone?: 'acc' | 'line'; action?: ReactNode }) {
  return (
    <div role="alert" className={cx('border px-3.5 py-3 flex gap-3 items-start', tone === 'acc' ? 'border-acc' : 'border-line')}>
      <span className="font-mono font-bold text-acc">[!]</span>
      <div className="flex flex-col gap-0.5 flex-grow">
        {title && <span className="font-bold">{title}</span>}
        {children && <span className="text-soft">{children}</span>}
      </div>
      {action}
    </div>
  );
}

// ---------- Inputs ----------
export function TextInput({ label, value, onChange, placeholder, autoFocus, id }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; id?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <input id={id} type="text" value={value} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        className="bg-bg border border-line3 p-3 text-fg text-[15px] rounded-none placeholder:text-dim" />
    </label>
  );
}

export function Check({ id, checked, onChange, children, boxed, disabled, sub, subTone }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode; boxed?: boolean; disabled?: boolean;
  sub?: ReactNode; subTone?: 'acc' | 'mute';
}) {
  return (
    <div className={cx('flex items-start gap-2.5', boxed && 'border border-line p-3')}>
      <input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-[3px]" />
      <label htmlFor={id} className={cx('flex-grow flex flex-col', disabled && 'opacity-60')}>
        <span className={sub ? 'font-semibold' : undefined}>{children}</span>
        {sub && <span className={cx('text-[12px]', subTone === 'acc' ? 'text-acc' : 'text-mute')}>{sub}</span>}
      </label>
    </div>
  );
}

export function Range({ label, valueText, min, max, step, value, onChange, hint, disabled }: {
  label: string; valueText: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
  hint?: string; disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="flex justify-between font-mono text-[11px] tracking-label">
        <span className="text-mute uppercase">{label}</span>
        <span>{valueText}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="text-[12px] text-mute">{hint}</span>}
    </label>
  );
}

/** Danh sách chọn một (dọc), như VOICE / TARGET VOICE trong UI mẫu. */
export function OptionList<T extends string>({ options, value, onChange, disabled }: {
  options: { id: T; name: ReactNode; tag?: ReactNode; disabled?: boolean }[]; value: T | undefined; onChange: (id: T) => void; disabled?: boolean;
}) {
  return (
    <div className="flex flex-col border border-line">
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} aria-pressed={value === o.id} disabled={disabled || o.disabled}
          className={cx('text-left border-0 border-b border-line2 last:border-b-0 px-3 py-2.5 cursor-pointer min-h-[44px] text-[14px] font-semibold flex justify-between gap-2', selCls(value === o.id))}>
          <span>{o.name}</span>
          {o.tag && <span className="font-mono text-[11px] opacity-70">{o.tag}</span>}
        </button>
      ))}
    </div>
  );
}

/** Nhóm nút chọn ngang (MODE, preset...). */
export function Segmented<T extends string>({ options, value, onChange, mono, disabled, className }: {
  options: { id: T; label: ReactNode; desc?: ReactNode; disabled?: boolean }[]; value: T; onChange: (id: T) => void;
  mono?: boolean; disabled?: boolean; className?: string;
}) {
  const rich = options.some((o) => o.desc);
  return (
    <div className={cx('flex flex-wrap border', rich ? 'border-line' : 'border-line3', className)}>
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} aria-pressed={value === o.id} disabled={disabled || o.disabled}
          className={cx('border-0 cursor-pointer', selCls(value === o.id),
            rich ? 'flex-[1_1_140px] px-3.5 py-3 min-h-[52px] text-left flex flex-col'
              : mono ? 'px-4 py-2.5 whitespace-nowrap font-mono font-bold text-[12px] tracking-[.08em] min-h-[44px]'
                : 'flex-1 p-2.5 font-semibold min-h-[42px]')}>
          {rich ? <><span className="font-bold">{o.label}</span><span className="text-[12px] opacity-75">{o.desc}</span></> : o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Visuals ----------
export function Segs({ level, n = 40, h = 14 }: { level: number; n?: number; h?: number }) {
  const lit = Math.round((Math.max(0, Math.min(100, level)) / 100) * n);
  return (
    <div className="flex-1 flex gap-[2px]">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex-1" style={{ height: h, background: i < lit ? (i >= n * 0.82 ? '#FF5B14' : '#F2F2F2') : '#1C1C1C' }} />
      ))}
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1 bg-line" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-1 bg-acc" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ title, onClose, children, footer, width = 520 }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,button:not([aria-label])')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="bg-bg border border-fg flex flex-col max-h-[90vh] w-full" style={{ maxWidth: width }}>
        <div className="flex justify-between items-center py-2 pr-2 pl-5 border-b border-line">
          <h2 className="m-0 font-mono text-[12px] tracking-wide2 font-bold">{title}</h2>
          <CloseBtn onClick={onClose} />
        </div>
        <div className="p-5 flex flex-col gap-4 overflow-auto">{children}</div>
        {footer && <div className="flex gap-2 flex-wrap justify-end px-5 pb-5">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ title, body, confirmLabel, danger, onConfirm, onClose }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn variant={danger ? 'primary' : 'inverse'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Btn>
      </>
    }>
      <div className="text-soft">{body}</div>
    </Modal>
  );
}
