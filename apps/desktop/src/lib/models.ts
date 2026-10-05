import { useEngine } from '../stores/engine';

/** Model tách nhạc nền đã tải chưa (mock engine coi như có). Dùng để bật/tắt ô "tách nhạc nền". */
export function useSeparatorReady(): boolean {
  return useEngine((s) => s.system?.models.find((m) => m.id === 'demucs-htdemucs')?.installed ?? s.info.status === 'mock');
}
