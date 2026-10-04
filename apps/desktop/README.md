# apps/desktop

App shell EasyVoice: Electron + React 18 + Vite + Tailwind + Zustand + i18next. Thiết kế theo
`docs/EasyVoice UI mẫu.html` (đã chốt). Chỉ lo giao diện; mọi xử lý AI nằm trong `engine/` (Python sidecar).

## Chạy

```bash
npm install
npm run dev            # chỉ renderer trong trình duyệt: http://localhost:5173 (dùng mock engine)
npm run electron:dev   # app Electron + Vite dev server
npm test               # vitest (chuẩn hóa văn bản preview, quy tắc hàng đợi GPU của mock engine)
npm run build          # typecheck + build renderer + bundle main/preload
```

## Trạng thái

Engine Python chưa có (Phase 1), nên UI chạy với **mock engine** (`src/api/mockEngine.ts`) mô phỏng đúng quy tắc của spec:
một job GPU nặng mỗi lúc (TTS phải chờ train), real-time giữ GPU độc quyền, tạm dừng train giữ checkpoint để tiếp tục,
chặn `.pth` chứa code. Header hiện `ENGINE: MOCK`. Khi có engine, thay `MockEngine` bằng client HTTP/WS cùng interface
`src/api/engine.ts`; `electron/sidecar.ts` đã có sẵn spawn engine (port động, token qua env, health check, tự restart,
không để sót process khi tắt app).

## Cấu trúc

- `electron/` — `main.ts` (cửa sổ, IPC: chọn file/thư mục, mở thư mục, đọc .txt), `preload.ts` (cầu nối tối thiểu,
  `contextIsolation`), `sidecar.ts` (vòng đời engine).
- `src/features/voices/` — danh sách giọng, wizard tạo giọng (Nhanh / Chất lượng cao, thu âm thật bằng micro),
  nhập (kiểm tra an toàn), xuất `.evoice`, chi tiết huấn luyện (log, tạm dừng / tiếp tục), đổi tên, xóa.
- `src/features/tts/` — đọc văn bản: mở .txt, từ điển phát âm, chuẩn hóa (xem trước), seed, nghỉ giữa câu,
  tiến độ theo câu, nghe từng câu, làm lại một câu, xuất WAV/MP3/FLAC/SRT.
- `src/features/sts/` — đổi giọng file (tách nhạc, index rate, protect, A/B, xuất) và real-time (thiết bị, preset,
  block/context/crossfade, VU, độ trễ, cảnh báo giật tiếng, hướng dẫn VB-Cable/BlackHole).
- `src/features/settings/` — cài đặt (ngôn ngữ, thư mục model/giọng, thiết bị, định dạng), giấy phép model,
  màn hình chạy lần đầu (kiểm tra GPU/ổ đĩa, chọn và tải model).
- `src/components/` — bộ component theo ngôn ngữ thiết kế của UI mẫu; `src/i18n/` — `vi.json`, `en.json` (đủ khóa).

Ghi chú: `src/api/types.ts` tạm viết tay; sẽ thay bằng types sinh từ OpenAPI (`packages/api-types`) khi engine có.
