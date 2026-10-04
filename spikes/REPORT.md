# Phase 0 — Báo cáo spike

> Mẫu để điền sau khi chạy spike trên máy thật. Số liệu lấy từ `spikes/results/*.json`.

## Máy thử

| | Windows | macOS |
|---|---|---|
| CPU / GPU | | |
| VRAM / RAM | | |
| Driver / OS | | |
| torch / CUDA | | |

## 1. F5-TTS tiếng Việt

Checkpoint: `…` (kiến trúc `…`, license `…`)

| Chỉ số | Windows CUDA | macOS MPS | Mục tiêu (spec mục 5) |
|---|---|---|---|
| Thời gian load | | | |
| RTF tổng (nfe 32) | | | ≤ 0.5 trên RTX 3060 |
| RTF tổng (nfe 16) | | | |
| VRAM đỉnh | | | |

Nghe thử (thanh điệu, nuốt/lặp chữ, câu xen tiếng Anh): …

## 2. RVC offline (RMVPE)

| Chỉ số | Windows CUDA | macOS MPS | Mục tiêu |
|---|---|---|---|
| RTF | | | < 1 trên GPU |
| VRAM đỉnh | | | |
| Click ở chỗ nối đoạn | | | không có |

Encoder ContentVec (transformers) cho chất lượng tương đương `hubert_base.pt` của RVC gốc? …

## 3. RVC real-time

| Block | Xử lý p95 (Win) | Trễ hạn (Win) | Xử lý p95 (Mac) | Trễ hạn (Mac) |
|---|---|---|---|---|
| 100 ms | | | | |
| 160 ms | | | | |
| 250 ms | | | | |

| Chỉ số | Windows | macOS | Mục tiêu |
|---|---|---|---|
| Độ trễ vòng thiết bị (`--roundtrip`) | | | |
| Độ trễ end-to-end (vòng + thuật toán) | | | ≤ 300 ms trên RTX 3060 |
| Underrun trong 30 phút | | | 0 |
| Dùng được làm micro Discord (VB-Cable / BlackHole) | | | có |

## 4. Train RVC (10 phút audio, preset "Cân bằng")

Công cụ: Applio `<tag/commit>`. Preset: `… epoch, batch …`

| Bước | Windows | macOS |
|---|---|---|
| Tiền xử lý | | |
| Extract feature (RMVPE) | | |
| Train | | |
| Build index | | |
| VRAM đỉnh | | |

## 5. License

Tóm tắt từ `LICENSES_CHECK.md`: …

## 6. Ảnh hưởng tới cam kết mục 5 & quyết định

- Cam kết cần sửa: …
- Phiên bản chốt: Python …, torch …, f5-tts …
- **Real-time trên Mac: Go / No-go / "Thử nghiệm"** — lý do: …
