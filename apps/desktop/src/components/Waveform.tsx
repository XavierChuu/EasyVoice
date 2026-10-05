// Waveform vẽ bằng canvas từ audio thật: đường bao min/max theo từng pixel thiết bị + lõi RMS,
// lưới thời gian, thước giây, vạch đánh dấu (ranh giới câu), playhead, hover và click/kéo để tua.
// Màu chủ đạo giữ như UI mẫu: phần chưa phát xám/trắng, phần đã phát cam #FF5B14.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { columnStats, loadPeaks, type Peaks, type WaveSource } from '../lib/peaks';

const ACC = '#FF5B14';
const GRID = 'rgba(255,255,255,0.055)';
const MID = 'rgba(255,255,255,0.14)';
const MUTE = '#6A6A6A';
const RULER_H = 15; // px CSS dành cho thước thời gian
const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export interface WaveMarker {
  at: number; // giây
  label?: string;
}

interface Props {
  source: WaveSource | null | undefined;
  height?: number;
  /** Màu phần chưa phát. */
  color?: string;
  /** Vị trí phát 0..1; undefined = không phát (không tô cam, không playhead). */
  position?: number;
  markers?: WaveMarker[];
  /** Hiện thước giây phía dưới (mặc định bật khi đủ cao). */
  ruler?: boolean;
  /** Chữ hiển thị khi chưa có dữ liệu (đang tải / không giải mã được). */
  placeholder?: string;
  onSeek?: (fraction: number) => void;
  label?: string;
  className?: string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function fmtTime(sec: number, step: number) {
  if (step < 1) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function tickStep(durationSec: number, cssWidth: number) {
  const want = (durationSec * 84) / Math.max(1, cssWidth);
  return TICKS.find((t) => t >= want) ?? TICKS[TICKS.length - 1];
}

function makeLayer(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Vẽ đường bao + lõi RMS một màu vào canvas riêng (vẽ lại chỉ khi đổi dữ liệu / kích thước). */
function paintEnvelope(c: HTMLCanvasElement, p: Peaks, top: number, plotH: number, color: string, peakAlpha: number) {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const W = c.width;
  const mid = top + plotH / 2;
  const half = plotH / 2;
  const gain = p.peak > 0.002 ? Math.min(20, 0.94 / p.peak) : 1; // chuẩn hóa để đoạn nhỏ vẫn nhìn được
  for (let x = 0; x < W; x++) {
    const { lo, hi, rms } = columnStats(p, x / W, (x + 1) / W);
    const yHi = Math.round(mid - hi * gain * half);
    const yLo = Math.round(mid - lo * gain * half);
    ctx.globalAlpha = peakAlpha;
    ctx.fillStyle = color;
    ctx.fillRect(x, Math.min(yHi, mid - 1), 1, Math.max(yLo, mid + 1) - Math.min(yHi, mid - 1));
    const r = Math.max(1, Math.round(rms * gain * half));
    ctx.globalAlpha = 1;
    ctx.fillRect(x, mid - r, 1, r * 2);
  }
  ctx.globalAlpha = 1;
}

export function Waveform({
  source, height = 72, color = '#F2F2F2', position, markers, ruler, placeholder, onSeek, label, className,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const layers = useRef<{ idle: HTMLCanvasElement; played: HTMLCanvasElement } | null>(null);
  const hover = useRef<number | null>(null);
  const dragging = useRef(false);
  const frame = useRef(0);
  const showRuler = ruler ?? height >= 56;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!source) return void setPeaks(null);
    let live = true;
    // Giữ dữ liệu cũ trong lúc nạp bản mới (vd. TTS ghép thêm câu) để waveform không nhấp nháy.
    void loadPeaks(source).then((p) => live && setPeaks(p));
    return () => { live = false; };
  }, [source]);

  const dims = useMemo(() => {
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    return { dpr, W: Math.max(1, Math.floor(width * dpr)), H: Math.max(1, Math.floor(height * dpr)) };
  }, [width, height]);

  const plot = useMemo(() => {
    const top = Math.round(4 * dims.dpr);
    const bottom = Math.round((showRuler ? RULER_H : 4) * dims.dpr);
    return { top, plotH: Math.max(2, dims.H - top - bottom), bottom };
  }, [dims, showRuler]);

  // Lớp tĩnh: đường bao chưa phát (màu gốc) và đã phát (cam).
  useEffect(() => {
    if (!peaks || !width) return void (layers.current = null);
    const idle = makeLayer(dims.W, dims.H);
    const played = makeLayer(dims.W, dims.H);
    paintEnvelope(idle, peaks, plot.top, plot.plotH, color, 0.42);
    paintEnvelope(played, peaks, plot.top, plot.plotH, ACC, 0.5);
    layers.current = { idle, played };
  }, [peaks, dims, plot, color, width]);

  const draw = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !width) return;
    const { dpr, W, H } = dims;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    ctx.clearRect(0, 0, W, H);
    const dur = peaks?.durationSec ?? 0;
    const mid = plot.top + plot.plotH / 2;
    const font = `${Math.round(10 * dpr)}px "JetBrains Mono", ui-monospace, monospace`;

    // Lưới dọc theo thời gian + thước
    if (dur > 0) {
      const step = tickStep(dur, width);
      ctx.font = font;
      ctx.textBaseline = 'alphabetic';
      for (let t = 0; t <= dur + 1e-6; t += step) {
        const x = Math.min(W - 1, Math.round((t / dur) * W));
        ctx.fillStyle = GRID;
        ctx.fillRect(x, 0, 1, H - (showRuler ? Math.round(RULER_H * dpr) : 0));
        if (showRuler) {
          ctx.fillStyle = MUTE;
          ctx.fillRect(x, H - Math.round(RULER_H * dpr), 1, Math.round(4 * dpr));
          const txt = fmtTime(t, step);
          const tw = ctx.measureText(txt).width;
          ctx.fillText(txt, Math.min(W - tw - 2, x + Math.round(4 * dpr)), H - Math.round(3 * dpr));
        }
      }
    } else {
      for (let x = 0; x < W; x += Math.round(60 * dpr)) {
        ctx.fillStyle = GRID;
        ctx.fillRect(x, 0, 1, H);
      }
    }
    // Đường giữa (0 dB) và ±50% biên độ
    ctx.fillStyle = GRID;
    for (const k of [-0.5, 0.5]) {
      const y = Math.round(mid + k * (plot.plotH / 2));
      for (let x = 0; x < W; x += Math.round(6 * dpr)) ctx.fillRect(x, y, Math.round(2 * dpr), 1);
    }
    ctx.fillStyle = MID;
    ctx.fillRect(0, Math.round(mid), W, 1);

    const L = layers.current;
    if (L && peaks) {
      const px = position !== undefined && position > 0 ? Math.round(clamp01(position) * W) : 0;
      if (px < W) ctx.drawImage(L.idle, px, 0, W - px, H, px, 0, W - px, H);
      if (px > 0) ctx.drawImage(L.played, 0, 0, px, H, 0, 0, px, H);
    } else if (placeholder) {
      ctx.font = font;
      ctx.fillStyle = MUTE;
      const tw = ctx.measureText(placeholder).width;
      ctx.fillText(placeholder, Math.max(8, (W - tw) / 2), mid - Math.round(8 * dpr));
    }

    // Vạch đánh dấu (ranh giới câu)
    if (dur > 0 && markers?.length) {
      ctx.font = font;
      markers.forEach((m) => {
        const x = Math.round(clamp01(m.at / dur) * W);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        for (let y = 0; y < H - Math.round(RULER_H * dpr); y += Math.round(4 * dpr)) ctx.fillRect(x, y, 1, Math.round(2 * dpr));
        if (m.label) {
          ctx.fillStyle = MUTE;
          ctx.fillText(m.label, x + Math.round(3 * dpr), plot.top + Math.round(9 * dpr));
        }
      });
    }

    // Hover
    if (hover.current !== null && peaks) {
      const x = Math.round(hover.current * W);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x, 0, 1, H);
      if (dur > 0) {
        const t = `${(hover.current * dur).toFixed(2)}s`;
        ctx.font = font;
        const tw = ctx.measureText(t).width + Math.round(8 * dpr);
        const bx = Math.min(W - tw, Math.max(0, x + Math.round(4 * dpr)));
        ctx.fillStyle = 'rgba(10,10,10,0.88)';
        ctx.fillRect(bx, plot.top, tw, Math.round(14 * dpr));
        ctx.fillStyle = '#F2F2F2';
        ctx.fillText(t, bx + Math.round(4 * dpr), plot.top + Math.round(10.5 * dpr));
      }
    }

    // Playhead
    if (position !== undefined && peaks && position >= 0) {
      const x = Math.min(W - 1, Math.round(clamp01(position) * W));
      ctx.fillStyle = ACC;
      ctx.fillRect(x, 0, Math.max(1, Math.round(dpr)), H);
      const s = Math.round(4 * dpr);
      ctx.beginPath();
      ctx.moveTo(x - s, 0);
      ctx.lineTo(x + s + 1, 0);
      ctx.lineTo(x, s + 1);
      ctx.closePath();
      ctx.fill();
    }
  }, [dims, plot, width, peaks, position, markers, placeholder, showRuler]);

  useEffect(() => { draw(); }, [draw, peaks, color]);

  const schedule = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(draw);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const frac = (e: PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return clamp01((e.clientX - r.left) / r.width);
  };
  const interactive = !!peaks;
  const onKey = (e: KeyboardEvent) => {
    if (!onSeek || !peaks) return;
    const cur = position ?? 0;
    if (e.key === 'ArrowRight') onSeek(clamp01(cur + 0.05));
    else if (e.key === 'ArrowLeft') onSeek(clamp01(cur - 0.05));
    else if (e.key === 'Home') onSeek(0);
    else if (e.key === 'End') onSeek(1);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={wrap} className={className} style={{ height, position: 'relative' }}>
      <canvas
        ref={canvas}
        role={onSeek ? 'slider' : 'img'}
        aria-label={label ?? 'Waveform'}
        aria-valuemin={onSeek ? 0 : undefined}
        aria-valuemax={onSeek ? 100 : undefined}
        aria-valuenow={onSeek ? Math.round((position ?? 0) * 100) : undefined}
        tabIndex={onSeek && interactive ? 0 : undefined}
        onKeyDown={onKey}
        style={{ width: '100%', height, display: 'block', cursor: onSeek && interactive ? 'pointer' : 'default', touchAction: 'none' }}
        onPointerMove={(e) => {
          if (!interactive) return;
          hover.current = frac(e);
          if (dragging.current && onSeek) onSeek(hover.current);
          schedule();
        }}
        onPointerLeave={() => { hover.current = null; schedule(); }}
        onPointerDown={(e) => {
          if (!interactive || !onSeek) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(frac(e));
        }}
        onPointerUp={(e) => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); }}
      />
    </div>
  );
}
