// Phím tắt đổi giọng khi đang live: GIỮ phím 1-9 (hàng số hoặc numpad) → giọng đã gán, nhả → về giọng mặc định.
// Cần hook bàn phím toàn cục (người dùng đang ở Discord/OBS/game, không focus EasyVoice) và cần cả sự kiện NHẢ phím,
// thứ globalShortcut của Electron không có → uiohook-napi. Hook chỉ chạy trong lúc live, chỉ báo phím 1-9, và
// không chặn phím (ứng dụng đang focus vẫn nhận phím như bình thường).
import { ipcMain, type WebContents } from 'electron';

type Uiohook = typeof import('uiohook-napi');
type KeyEvent = { keycode: number };

let mod: Uiohook | null | undefined;
let loadError = '';

function load(): Uiohook | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('uiohook-napi') as Uiohook;
  } catch (err) {
    mod = null;
    loadError = (err as Error).message;
  }
  return mod;
}

export function setupHotkeys(target: () => WebContents | undefined) {
  let running = false;
  const held = new Set<number>();
  let digitOf = new Map<number, string>();

  const send = (digit: string, down: boolean) => target()?.send('hotkeys:key', { digit, down });
  const onDown = (e: KeyEvent) => {
    const d = digitOf.get(e.keycode);
    if (!d || held.has(e.keycode)) return; // bỏ lặp phím khi giữ
    held.add(e.keycode);
    send(d, true);
  };
  const onUp = (e: KeyEvent) => {
    const d = digitOf.get(e.keycode);
    if (!d || !held.delete(e.keycode)) return;
    send(d, false);
  };

  const stop = () => {
    if (!running || !mod) return;
    mod.uIOhook.off('keydown', onDown);
    mod.uIOhook.off('keyup', onUp);
    mod.uIOhook.stop();
    running = false;
    held.clear();
  };

  // Trả về true nếu bắt phím toàn cục được; false → renderer chỉ bắt phím khi cửa sổ đang focus.
  ipcMain.handle('hotkeys:enable', (_e, on: boolean): { global: boolean; error?: string } => {
    if (!on) {
      stop();
      return { global: false };
    }
    const h = load();
    if (!h) return { global: false, error: loadError };
    if (!running) {
      const K = h.UiohookKey as Record<string, number>;
      digitOf = new Map();
      for (let i = 1; i <= 9; i++) {
        digitOf.set(K[String(i)], String(i));
        digitOf.set(K[`Numpad${i}`], String(i));
      }
      try {
        h.uIOhook.on('keydown', onDown);
        h.uIOhook.on('keyup', onUp);
        h.uIOhook.start();
        running = true;
      } catch (err) {
        h.uIOhook.off('keydown', onDown);
        h.uIOhook.off('keyup', onUp);
        return { global: false, error: (err as Error).message }; // macOS chưa cấp quyền Accessibility...
      }
    }
    return { global: true };
  });

  return stop;
}
