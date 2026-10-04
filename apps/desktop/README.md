# apps/desktop

App shell: Electron + React + Vite + Tailwind. Chỉ lo giao diện; mọi xử lý AI nằm trong `engine/` (Python sidecar).

- `electron/` — main process: vòng đời sidecar (port động, token, health check, tự restart), IPC, menu, updater.
- `src/features/` — mỗi tab một thư mục: `voices/`, `tts/`, `sts/`.
- `src/components/` — Waveform, VuMeter, JobProgress...
- `src/api/` — client sinh từ OpenAPI của engine + WebSocket client.
- `src/stores/` — Zustand. `src/i18n/` — `vi.json`, `en.json`.

Chưa triển khai — bắt đầu ở Phase 2.
