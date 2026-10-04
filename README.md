# EasyVoice

Ứng dụng desktop chạy Voice AI 100% local: Text-to-Speech (F5-TTS), đổi giọng offline/real-time (RVC v2),
quản lý và huấn luyện giọng. Ưu tiên tiếng Việt. Windows 10/11 (NVIDIA CUDA) và macOS 13+ (Apple Silicon).

## Trạng thái

- **Phase 0 — Spike kỹ thuật**: script đo hiệu năng F5-TTS và RVC trong `spikes/` (test tiếng Anh trước, xem
  `spikes/README.md`). Kết quả và quyết định Go/No-go ghi ở `spikes/REPORT.md`.
- **Engine Python — Phase 1** (`engine/`): FastAPI sidecar, TTS F5-TTS, đổi giọng offline RVC, quản lý giọng, tải model.
  Cài theo `engine/README.md`.
- **App desktop** (`apps/desktop`): giao diện theo UI mẫu, tự bật engine nếu đã cài (không thì chạy mock).
  `cd apps/desktop && npm install && npm run electron:dev`.
- Đề xuất kỹ thuật: `docs/adr/0001-de-xuat-ky-thuat.md`.

## Cấu trúc

```
apps/desktop/     Electron + React (Phase 2)
engine/           Python sidecar FastAPI (Phase 1); third_party/ chứa code vendored
packages/api-types/  TypeScript types sinh từ OpenAPI
spikes/           Phase 0: script đo hiệu năng, không đưa vào app
docs/             Đặc tả, UI mẫu, câu hỏi mở, ADR
scripts/          Build, đóng gói
models.manifest.json  Danh sách model chính thức (url, sha256, size, license)
```

Model và dữ liệu người dùng không bao giờ nằm trong repo.
