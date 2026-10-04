# engine

Python backend (FastAPI), chạy như sidecar của Electron, chỉ lắng nghe trên `127.0.0.1` với port động + token.

- `easyvoice_engine/api/` — routers: tts, sts, voices, jobs, system.
- `easyvoice_engine/core/` — ModelManager, JobQueue, device, paths.
- `easyvoice_engine/services/` — tts (F5), rvc (infer/train/realtime), preprocess, `audio_io.py`.
- `easyvoice_engine/schemas/` — Pydantic models.
- `third_party/` — code vendored (ghi rõ nguồn, commit, license).
- `requirements/` — `base.txt`, `cuda.txt`, `mps.txt` (lock riêng từng nền tảng), quản lý bằng uv.

Chưa triển khai — bắt đầu ở Phase 1 sau khi có kết quả Phase 0 (`spikes/REPORT.md`).
