# ADR-0001 — Đề xuất kỹ thuật cho v1

Trạng thái: **Đề xuất** (Oct 2026). Các mục đánh dấu ⏳ sẽ chốt bằng số đo Phase 0 (`spikes/REPORT.md`).

## Trả lời các câu hỏi mở

| # | Câu hỏi | Đề xuất | Lý do |
|---|---|---|---|
| 1 | Miễn phí hay bán? | **v1 miễn phí, phi thương mại.** Kiến trúc giữ TTS sau một wrapper (`f5_wrapper.py`) để thay model khi làm bản trả phí. | Weights F5-TTS gốc là CC-BY-NC; đa số checkpoint tiếng Việt cộng đồng kế thừa NC. Bán ngay là rủi ro pháp lý lớn nhất của dự án. |
| 2 | Checkpoint F5-TTS tiếng Việt? | ⏳ Phase 0 chấm 2-3 ứng viên trên `texts_vi.txt` theo 3 tiêu chí: đúng thanh điệu, không nuốt/lặp chữ, license. **Test tiếng Anh trước** bằng checkpoint gốc để tách lỗi môi trường khỏi lỗi checkpoint. | Không có checkpoint nào "chuẩn" — phải nghe thử. |
| 3 | GPU AMD trên Windows ở v2? | **Không đưa vào lộ trình.** Giữ fallback CPU. Xem lại khi PyTorch ROCm trên Windows ổn định. | DirectML không hỗ trợ đủ op cho F5/RVC; chi phí test cao. |
| 4 | Ký số đứng tên ai? | **Cá nhân** cho tới khi có doanh thu: Apple Developer ID (cá nhân), Windows dùng chứng chỉ OV hoặc dịch vụ ký số đám mây nếu đủ điều kiện. Đổi sang công ty khi thương mại hóa. | Rẻ, đủ để tránh cảnh báo Gatekeeper/SmartScreen về lâu dài. |

## Chỗ spec chưa nhất quán

| Vấn đề | Đề xuất |
|---|---|
| Profile ghi `model.pth`, nhưng `.evoice` chỉ nhận `safetensors` | Profile lưu **`model.safetensors`** + cấu hình RVC (`config`, `sr`, `f0`, `version`) trong `profile.json`. Model tự train hay import đều convert ngay, không giữ `.pth` → một đường load duy nhất, an toàn. |
| Chain cần "một giọng chuẩn đẹp" | Người dùng chọn **giọng nền** là một profile Quick bất kỳ của họ (mặc định: profile Quick gần nhất). Không bundle giọng nền trong v1 trừ khi tìm được ref có license rõ ràng. |
| Giọng "Chất lượng cao" có dùng cho TTS không? | Có (UI mẫu ghi "Works for both"). Khi train, app **tự chọn một đoạn sạch 5-12 s** trong dataset + Whisper làm ref cho F5-TTS, nên profile có cả TTS lẫn STS. |
| Train RVC trong app | **Đã làm (Phase 3):** vòng lặp train tự viết theo công thức RVC v2 40k; phần phụ trợ (loss, mel, slicer) vendored từ gói `rvc` 0.3.5 chính thức (MIT) — Applio không lấy được trong môi trường build. Khởi tạo từ pretrained f0G/f0D, batch tự chọn theo VRAM (6 GB → 4), fp16 trên CUDA, CPU bị từ chối (`GPU_REQUIRED`). ⏳ chất lượng/thời gian đo trên máy thật. |
| Encoder nội dung | **ContentVec dạng `transformers`** thay cho `hubert_base.pt` (fairseq). ⏳ nghe so sánh ở Phase 0. |

## Stack

| Phần | Chọn | Ghi chú |
|---|---|---|
| Python | 3.11, uv, torch 2.8 (CUDA 12.8 / MPS) | ⏳ |
| TTS | F5-TTS 1.1.x, vocos 24 kHz | output 24 kHz |
| VC | RVC v2 + RMVPE, code vendored ở `engine/third_party/rvc` | |
| Tách vocal | **Demucs (htdemucs)** — MIT | Dùng cho tiền xử lý train và STS offline (tách → đổi giọng → trộn lại). Nạp từ thư mục model của app. ⏳ tốc độ trên máy thật. |
| ASR transcript | faster-whisper, model `small` (đa ngôn ngữ) | MIT |
| Chuẩn hóa văn bản | Module rule-based tự viết + từ điển người dùng | ≥ 50 test case (Phase 1) |
| App shell | Electron + React 18 + Vite + Tailwind + Zustand + i18next | |
| Font | Chakra Petch + JetBrains Mono, đóng gói qua `@fontsource` (OFL) | chạy offline, không gọi Google Fonts |
| Waveform | wavesurfer.js (Phase 5) | |

## Luồng dữ liệu UI ↔ engine

- Renderer **không** gọi Node trực tiếp (`contextIsolation`, không `nodeIntegration`). Preload chỉ lộ: chọn file, mở thư mục,
  thông tin kết nối engine (port + token).
- Renderer gọi engine qua HTTP + WebSocket kèm token (spec mục 4). Trong lúc chưa có engine, renderer dùng
  **mock engine** cùng interface (`src/api/engine.ts`) để dựng và test toàn bộ UI. Types của interface viết tay tạm thời,
  sẽ thay bằng types sinh từ OpenAPI khi engine có ở Phase 1-2.
- Thu âm đoạn ref 5-12 s ("Record now") làm trong renderer bằng MediaRecorder rồi gửi file lên engine; **luồng real-time
  vẫn do Python mở micro/loa** như spec.

## UI

- `docs/EasyVoice UI mẫu.html` là thiết kế **đã chốt**. App (`apps/desktop`) dựng đúng 3 màn hình của bản mẫu và bổ sung
  các phần spec yêu cầu nhưng bản mẫu chưa vẽ: đổi tên/xóa giọng, chi tiết huấn luyện (log, tạm dừng/tiếp tục), thu âm,
  từ điển phát âm, mở .txt, seed, nghỉ giữa câu, nghe từng câu, FLAC, index rate/protect, A/B, tùy chỉnh real-time,
  hướng dẫn thiết bị ảo, cài đặt, giấy phép, màn hình chạy lần đầu, banner engine lỗi, toast, hộp xác nhận, VI/EN.
- Hàng đợi GPU theo đúng spec: TTS/STS bấm trong lúc đang train sẽ **chờ** (hiện "Đang chờ: <tên>"); người dùng có thể
  tạm dừng train (giữ checkpoint) để chạy ngay.

## Thứ tự test âm thanh

1. Tiếng Anh: F5-TTS gốc + ref tiếng Anh đi kèm gói (`spikes/prepare_samples.py`).
2. RVC offline / real-time trên audio tiếng Anh đó.
3. Chuyển sang checkpoint tiếng Việt và audio tiếng Việt.
