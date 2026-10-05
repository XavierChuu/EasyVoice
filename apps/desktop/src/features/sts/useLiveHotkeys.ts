// Giữ phím 1-9 khi đang live → giọng đã gán; nhả → về giọng mặc định. Giữ nhiều phím: phím nhấn sau cùng thắng.
// Electron: hook toàn cục (dùng được khi đang ở app khác). Trình duyệt / hook lỗi: chỉ khi cửa sổ đang focus.
import { useEffect, useRef, useState } from 'react';

import { platform } from '../../lib/platform';

export type HotkeyMode = 'off' | 'global' | 'window';

const DIGIT = /^[1-9]$/;

export function useLiveHotkeys(enabled: boolean, assigned: Set<string>) {
  const [active, setActive] = useState<string | null>(null);
  const [mode, setMode] = useState<HotkeyMode>('off');
  const [error, setError] = useState('');
  const stack = useRef<string[]>([]);
  const assignedRef = useRef(assigned);
  assignedRef.current = assigned;

  useEffect(() => {
    if (!enabled) {
      stack.current = [];
      setActive(null);
      setMode('off');
      return;
    }
    let alive = true;
    let global = false;
    const sync = () => setActive(stack.current[stack.current.length - 1] ?? null);
    const press = (d: string) => {
      if (!assignedRef.current.has(d) || stack.current.includes(d)) return; // phím chưa gán / lặp phím
      stack.current = [...stack.current, d];
      sync();
    };
    const release = (d: string) => {
      if (!stack.current.includes(d)) return;
      stack.current = stack.current.filter((x) => x !== d);
      sync();
    };

    const offGlobal = platform.onHotkey((ev) => (ev.down ? press(ev.digit) : release(ev.digit)));
    void platform.enableHotkeys(true).then((r) => {
      if (!alive) return;
      global = r.global;
      setMode(r.global ? 'global' : 'window');
      setError(r.error ?? '');
    });

    // Bắt thêm trong cửa sổ: dự phòng khi không có hook toàn cục (trùng sự kiện thì press/release tự bỏ qua).
    const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const digitOf = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || editable(e.target)) return null;
      const d = e.code.startsWith('Numpad') ? e.code.slice(6) : e.code.startsWith('Digit') ? e.code.slice(5) : '';
      return DIGIT.test(d) ? d : null;
    };
    const down = (e: KeyboardEvent) => {
      const d = digitOf(e);
      if (d && !e.repeat) press(d);
    };
    const up = (e: KeyboardEvent) => {
      const d = e.code.startsWith('Numpad') ? e.code.slice(6) : e.code.startsWith('Digit') ? e.code.slice(5) : '';
      if (DIGIT.test(d)) release(d);
    };
    // Mất focus mà không có hook toàn cục thì không biết lúc nhả phím → về giọng mặc định cho an toàn.
    const blur = () => {
      if (global) return;
      stack.current = [];
      sync();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      alive = false;
      offGlobal();
      void platform.enableHotkeys(false);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      stack.current = [];
    };
  }, [enabled]);

  return { active, mode, error };
}
