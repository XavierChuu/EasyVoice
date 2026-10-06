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

## Engine

Có `engine/.venv` (xem `engine/README.md`) thì Electron tự bật engine Python thật và UI dùng `src/api/httpEngine.ts`
(REST + WebSocket, types sinh từ OpenAPI). Không có thì UI chạy **mock engine** (`src/api/mockEngine.ts`) mô phỏng đúng quy tắc của spec:
một job GPU nặng mỗi lúc (TTS phải chờ train), real-time giữ GPU độc quyền, tạm dừng train giữ checkpoint để tiếp tục,
chặn `.pth` chứa code. Header hiện `ENGINE: MOCK`. Khi có engine, thay `MockEngine` bằng client HTTP/WS cùng interface
`src/api/engine.ts`. `electron/sidecar.ts`: spawn engine (port động, token qua env, health check, tự restart,
không để sót process khi tắt app).

Trình duyệt + engine chạy riêng: `VITE_ENGINE_URL=http://127.0.0.1:8765 VITE_ENGINE_TOKEN=dev npm run dev`.

## Đóng gói (Phase 6)

```bash
npm run fetch:ffmpeg   # FFmpeg LGPL → vendor/ffmpeg/<platform>-<arch> (Windows tải BtbN; macOS: --from <ffmpeg LGPL tự dựng>)
npm run dist           # bộ cài vào release/ (Windows: NSIS .exe; macOS: .dmg + .zip), không publish
npm run release        # build + đăng lên GitHub Releases (cần GH_TOKEN) → electron-updater của bản đã cài thấy bản mới
```

- Bộ cài chỉ gồm app shell + mã engine (`extraResources`: `resources/engine`, `resources/models.manifest.json`,
  `resources/ffmpeg`). Lần mở đầu hiện màn hình **Cài đặt lần đầu** (`RuntimeSetupModal`): `electron/runtime.ts` tải
  `uv` → Python 3.11 → venv → PyTorch đúng loại máy (Windows có `nvidia-smi` → CUDA; Mac Apple Silicon → MPS; còn lại
  CPU) → thư viện engine, vào `%APPDATA%\EasyVoice\runtime` / `~/Library/Application Support/EasyVoice/runtime`.
  Rớt mạng → Thử lại tiếp tục từ cache. Sau đó tới màn hình tải model như cũ.
- Ký số: Windows `CSC_LINK` + `CSC_KEY_PASSWORD`; macOS `CSC_NAME` (Developer ID) + `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` để notarize (`build/entitlements.mac.plist`: micro, JIT,
  disable-library-validation cho Python do uv cài).
- Gỡ cài đặt Windows hỏi có xoá `%APPDATA%\EasyVoice` (giọng, model, runtime) không; mặc định giữ lại
  (`build/installer.nsh`). Cập nhật tự động không hỏi.
- Biến môi trường để thử luồng cài đặt khi dev: `EASYVOICE_FORCE_SETUP=1` (bỏ qua `engine/.venv`),
  `EASYVOICE_ENGINE_DIR=<repo>/engine`, `EASYVOICE_DATA_DIR=<thư mục tạm>`, `EASYVOICE_TORCH=cpu|cuda|mps`,
  `EASYVOICE_RUNTIME_REQS=<file requirements nhỏ>`; `EASYVOICE_NO_UPDATE=1` tắt tự cập nhật.

## Cấu trúc

- `electron/` — `main.ts` (cửa sổ, IPC: chọn file/thư mục, mở thư mục, đọc .txt), `preload.ts` (cầu nối tối thiểu,
  `contextIsolation`), `sidecar.ts` (vòng đời engine), `runtime.ts` (cài runtime Python lần đầu của bản cài đặt).
- `src/features/voices/` — danh sách giọng, wizard tạo giọng (Nhanh / Chất lượng cao, thu âm thật bằng micro),
  nhập (kiểm tra an toàn), xuất `.evoice`, chi tiết huấn luyện (log, tạm dừng / tiếp tục), đổi tên, xóa.
- `src/features/tts/` — đọc văn bản: mở .txt, từ điển phát âm, chuẩn hóa (xem trước), seed, nghỉ giữa câu,
  tiến độ theo câu, nghe từng câu, làm lại một câu, xuất WAV/MP3/FLAC/SRT.
- `src/features/sts/` — đổi giọng file (tách nhạc, index rate, protect, A/B, xuất) và real-time (thiết bị, preset,
  block/context/crossfade, VU, độ trễ, cảnh báo giật tiếng, hướng dẫn VB-Cable/BlackHole).
- `src/features/settings/` — cài đặt (ngôn ngữ, thư mục model/giọng, thiết bị, định dạng), giấy phép model,
  màn hình chạy lần đầu (kiểm tra GPU/ổ đĩa, chọn và tải model).
- `src/components/` — bộ component theo ngôn ngữ thiết kế của UI mẫu; `src/i18n/` — `vi.json`, `en.json` (đủ khóa).

Types API trong `src/api/types.ts` lấy từ `packages/api-types` (sinh từ OpenAPI: `npm run gen:api`).
