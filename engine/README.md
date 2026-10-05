# engine

Python sidecar (FastAPI) chạy AI 100% local. Electron tự khởi động engine (port động, token qua biến môi trường),
chỉ lắng nghe trên `127.0.0.1`, mọi request phải kèm token.

## Phase 1 — đã có

| Phần | File |
|---|---|
| Khung FastAPI, xác thực token, lỗi có mã + thông điệp tiếng Việt | `main.py`, `core/errors.py` |
| Đường dẫn dữ liệu theo OS, settings.json | `core/paths.py`, `core/settings.py` |
| Device (CUDA / MPS / CPU, tự fallback), VRAM | `core/device.py` |
| **ModelManager**: load lười, gỡ theo LRU khi đổi tác vụ, `empty_cache` | `core/model_manager.py` |
| **JobQueue**: 1 job GPU nặng mỗi lúc, hủy, real-time giữ GPU độc quyền | `core/job_queue.py` |
| Tải model theo `models.manifest.json`: sha256, tải tiếp khi rớt mạng | `services/models.py` |
| Chuẩn hóa văn bản tiếng Việt (88 test case) + tiếng Anh, từ điển riêng | `services/tts/text_normalize_*.py` |
| TTS F5-TTS (chế độ Trực tiếp): tách câu, render từng câu, nghe câu đã xong, render lại 1 câu, WAV/MP3/FLAC/SRT | `services/tts/` |
| STS offline RVC v2 + RMVPE: chia đoạn + crossfade, output cùng sample rate với input | `services/rvc/infer.py` |
| Quản lý giọng: tạo nhanh (cắt lặng, chuẩn hóa −16 LUFS, cảnh báo), đổi tên, xóa, nghe thử | `services/voices.py` |
| Nhập `.pth` an toàn: `weights_only` trong process riêng → safetensors; chặn pickle độc | `services/rvc/import_pth.py` |
| Whisper (faster-whisper) cho transcript | `services/preprocess/asr.py` |

## Phase 3 — đã có

| Phần | File |
|---|---|
| Huấn luyện giọng "Chất lượng cao" chạy dạng job: tiền xử lý → kiểm tra dataset → ContentVec + RMVPE → train → faiss index + file nghe thử | `services/rvc/train/pipeline.py` |
| Tiền xử lý: FFmpeg, tách nhạc nền Demucs, khử nhiễu nhẹ (theo cửa sổ 20 s), cắt câu theo khoảng lặng, đoạn 3,7 s | `services/preprocess/` |
| Vòng lặp train RVC v2 40k (GAN: mel ×45 + KL + feature matching + adversarial), từ pretrained f0G/f0D, fp16 trên CUDA, batch tự chọn theo VRAM | `services/rvc/train/trainer.py` |
| Preset Nhanh / Cân bằng / Kỹ (100 / 200 / 400 epoch) | `services/rvc/train/config.py` |
| Tạm dừng = lưu checkpoint; Tiếp tục bỏ qua bước đã xong và train tiếp từ checkpoint; tắt app giữa chừng → mở lại vẫn tiếp tục được | `api/train.py` |
| Giọng train xong dùng được cho cả TTS: tự chọn đoạn sạch 5-12 s + transcript Whisper | `pipeline._make_tts_ref` |
| TTS chế độ "Qua RVC": F5-TTS đọc hết rồi đổi giọng từng câu bằng RVC (2 lượt, không nạp/gỡ model liên tục) | `services/tts/pipeline.py` |
| Đổi giọng file: tách nhạc nền → đổi giọng → trộn lại với nhạc gốc | `api/sts.py` |

Huấn luyện cần GPU (NVIDIA hoặc Apple Silicon) — CPU bị từ chối (`GPU_REQUIRED`) theo bảng phần cứng của spec.
Cần các model: ContentVec, RMVPE, RVC pretrained v2 40k; thêm Demucs nếu bật tách nhạc nền.

Chưa có (trả lỗi `NOT_IMPLEMENTED`, UI báo rõ): real-time (Phase 4), nhập/xuất `.evoice` (Phase 5).

## Cài đặt (dev)

Cần [uv](https://docs.astral.sh/uv/) và FFmpeg trong PATH (để đọc mp3/m4a/video và xuất MP3).

```powershell
# Windows + NVIDIA
cd engine
uv venv -p 3.11 .venv
.venv\Scripts\activate
uv pip install -r requirements\cuda.txt
uv pip install -r requirements\base.txt
```

```bash
# macOS Apple Silicon
cd engine
uv venv -p 3.11 .venv && source .venv/bin/activate
uv pip install -r requirements/mps.txt
uv pip install -r requirements/base.txt
```

Sau đó chạy app (`cd apps/desktop && npm run electron:dev`): Electron tìm thấy `engine/.venv` và tự bật engine,
header đổi thành `ENGINE: SẴN SÀNG`. Màn hình chạy lần đầu tải model (F5-TTS gốc tiếng Anh ~1,4 GB, vocos, Whisper,
ContentVec, RMVPE) vào thư mục dữ liệu: `%APPDATA%\EasyVoice\models` (Windows), `~/Library/Application Support/EasyVoice/models` (macOS).

Không có `engine/.venv` thì app chạy mock engine như trước. Đặt `EASYVOICE_PYTHON` để dùng Python khác,
`EASYVOICE_MOCK=1` để ép dùng mock.

### Chạy engine riêng (curl / Swagger)

```bash
EASYVOICE_TOKEN=dev python -m easyvoice_engine.main --port 8765
# Swagger: http://127.0.0.1:8765/docs  (bấm Authorize, nhập token "dev")
curl -H "Authorization: Bearer dev" http://127.0.0.1:8765/system/info
```

UI trong trình duyệt nối vào engine này: `VITE_ENGINE_URL=http://127.0.0.1:8765 VITE_ENGINE_TOKEN=dev npm run dev`.

### Checkpoint tiếng Việt

Thêm một mục vào `models.manifest.json` (file checkpoint + `vocab.txt`, `arch` = `F5TTS_Base` hoặc `F5TTS_v1_Base`)
rồi đặt `"tts_model": "<id>"` trong `settings.json` của thư mục dữ liệu.

## Test

```bash
python -m pytest -q                      # chạy trên CPU, không cần tải model (2 bài train thật ~20 phút)
EASYVOICE_SLOW=1 python -m pytest -q tests/test_f5_integration.py   # chạy thật thư viện f5-tts (trọng số ngẫu nhiên)
```

Test dùng TTS giả và RVC/ContentVec/RMVPE khởi tạo ngẫu nhiên để chạy đủ đường code (API → JobQueue → ModelManager
→ model → file). Gồm: ≥ 50 case chuẩn hóa tiếng Việt, load/unload model 20 lần không rò (CUDA: kiểm
`memory_allocated`), chặn `.pth` độc, tải tiếp khi rớt mạng.

## Sinh types TypeScript từ OpenAPI

```bash
python -m easyvoice_engine.openapi > ../packages/api-types/openapi.json
cd ../apps/desktop && npm run gen:api
```
