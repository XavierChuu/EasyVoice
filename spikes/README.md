# Phase 0 — Spike kỹ thuật

Script thuần (không API, không UI) để kiểm chứng rủi ro trước khi viết app. **Code ở đây không đưa vào app.**
Kết quả nghiệm thu: điền `REPORT.md` (số đo, ảnh hưởng tới cam kết mục 5 của spec, quyết định Go/No-go real-time trên Mac).

| Việc cần làm (spec mục 7) | Script | Kết quả ghi vào |
|---|---|---|
| F5-TTS checkpoint tiếng Việt trên CUDA và MPS, đo RTF + VRAM đỉnh | `f5_tts_spike.py` | `results/f5_tts-*.json`, `out/f5/*.wav` |
| RVC infer offline + RMVPE | `rvc_offline_spike.py` | `results/rvc_offline-*.json` |
| RVC real-time tối giản micro → model → loa, độ trễ ở block 100/160/250 ms | `rvc_realtime_spike.py` | `results/rvc_realtime_*.json` |
| Thời gian train 10 phút audio × 1 preset | `time_cmd.py` + công cụ train ngoài (Applio) | `results/time_*.json` |
| Kiểm tra license từng checkpoint | — | `LICENSES_CHECK.md` |

Các file khác: `common.py` (device, đo thời gian/VRAM, ghi kết quả), `rvc_core.py` (pipeline RVC dùng chung),
`download_models.py` + `models.spike.json` (tải model, kiểm sha256), `texts_vi.txt` (câu thử TTS), `tests/` (pytest).
Code RVC vendored (kiến trúc model + RMVPE) nằm ở `engine/third_party/rvc/`.

---

## 1. Cài môi trường

Yêu cầu chung: [uv](https://docs.astral.sh/uv/), Git, Python 3.11 (uv tự tải được). Windows cần driver NVIDIA mới
(hỗ trợ CUDA 12.8). Cài torch **trước**, rồi mới cài phần còn lại, để `f5-tts` không tự kéo bản torch khác.

### Windows 10/11 + NVIDIA (PowerShell)

```powershell
cd spikes
uv venv -p 3.11 .venv
.venv\Scripts\activate
uv pip install -r requirements\cuda.txt
uv pip install -r requirements\base.txt
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

### macOS 13+ Apple Silicon

```bash
cd spikes
uv venv -p 3.11 .venv
source .venv/bin/activate
uv pip install -r requirements/mps.txt
uv pip install -r requirements/base.txt
python -c "import torch; print(torch.__version__, torch.backends.mps.is_available())"
```

Một số phép toán chưa có trên MPS sẽ báo lỗi; khi đó chạy với `PYTORCH_ENABLE_MPS_FALLBACK=1` và **ghi lại vào REPORT.md**
(fallback CPU làm chậm, ảnh hưởng số đo).

### Kiểm tra code (không cần model, không cần GPU)

```bash
python -m pytest tests -q
```

`tests/test_framing.py` kiểm tra việc chia đoạn offline và ghép SOLA real-time bằng một converter giả (resample thuần):
output phải trùng input sau khi bù độ trễ, không có tiếng click.
Có thể chạy thử toàn bộ đường code RVC với trọng số ngẫu nhiên bằng cờ `--dummy` (output là nhiễu, chỉ để test).

## 2. Tải model

```bash
python download_models.py                # rmvpe, ContentVec, vocos → spikes/models/
python download_models.py --group tts-base   # (tùy chọn) F5-TTS gốc để so tốc độ
```

Script in sha256 của từng file — ghi lại vào `models.spike.json` để lần sau kiểm tra.

### Checkpoint F5-TTS tiếng Việt

Chưa chốt (câu hỏi mở số 2 trong spec). Tìm trên Hugging Face với từ khóa "F5-TTS Vietnamese", ví dụ
`hynt/F5-TTS-Vietnamese-ViVoice`. Với mỗi ứng viên cần ghi lại: file checkpoint, `vocab.txt`, cấu hình kiến trúc
(`F5TTS_v1_Base` hay `F5TTS_Base`), **license** (nhiều bản kế thừa CC-BY-NC). Đặt vào `spikes/models/f5-vi-<tên>/`.

### Model RVC để thử

Cần một model RVC **v2** (`.pth` + `.index`) của giọng có quyền sử dụng — lý tưởng là model tự train ở mục 5 bên dưới.
`.pth` được load bằng `torch.load(weights_only=True)`: file chứa code (pickle độc) sẽ bị từ chối.

### Audio mẫu

Đặt trong `spikes/samples/` (đã gitignore — giọng thật không được commit):
- `ref.wav`: 5-12 s giọng sạch + transcript chính xác (cho TTS).
- `giong_noi.wav`: 1-3 phút giọng nói (cho STS offline / bench real-time).

## 3. F5-TTS

```bash
python f5_tts_spike.py \
  --ckpt models/f5-vi-<tên>/model.pt --vocab models/f5-vi-<tên>/vocab.txt --model F5TTS_Base \
  --ref-audio samples/ref.wav --ref-text "transcript chính xác của ref"
```

- Chạy thêm `--nfe 16` để xem đánh đổi tốc độ/chất lượng.
- Nghe `out/f5/*.wav`: thanh điệu đúng không, có nuốt chữ/lặp chữ không, câu tiếng Anh xen kẽ ra sao.
- Số cần lấy: `rtf_overall` (mục tiêu ≤ 0.5 trên RTX 3060), `memory.peak_allocated_mb` (CUDA),
  `mps_driver_peak_mb_sampled` (Mac, lấy mẫu sau mỗi câu nên chỉ là xấp xỉ).

## 4. RVC

### Offline

```bash
python rvc_offline_spike.py --input samples/giong_noi.wav \
  --model models/rvc/voice.pth --index models/rvc/voice.index --pitch 0
```

Số cần lấy: `rtf` (spec: nhanh hơn thời gian thực trên GPU ⇒ RTF < 1), VRAM đỉnh. Nghe chỗ nối giữa các đoạn
(mặc định 30 s, crossfade 50 ms) xem có click không.

### Real-time

```bash
# 1) Bench không cần thiết bị: thời gian xử lý mỗi block ở 100/160/250 ms
python rvc_realtime_spike.py --bench-input samples/giong_noi.wav --model models/rvc/voice.pth

# 2) Liệt kê thiết bị, phát hiện VB-Cable / BlackHole
python rvc_realtime_spike.py --list-devices

# 3) Đo độ trễ vòng của thiết bị (nối dây out→in, hoặc micro sát loa)
python rvc_realtime_spike.py --roundtrip --input-device <id> --output-device <id> --block-ms 160

# 4) Chạy thật — nghe bằng tai nghe; --duration 1800 cho bài test 30 phút không underrun
python rvc_realtime_spike.py --model models/rvc/voice.pth --input-device <id> --output-device <id> \
  --preset balanced --duration 1800
```

- Một block "trễ hạn" khi thời gian xử lý > độ dài block ⇒ sẽ gây underrun. `load_ratio_p95` < ~0.7 mới an toàn.
- **Độ trễ end-to-end ≈ độ trễ vòng thiết bị (bước 3) + độ trễ thuật toán** (`algorithmic_latency_ms` = crossfade + vùng
  SOLA). Chế độ live cũng in một số *ước tính* từ độ trễ PortAudio báo cáo, chỉ để tham khảo.
- Mục tiêu: ≤ 300 ms trên RTX 3060. Trên Mac chỉ đo và ghi lại để quyết định Go/No-go.
- Thử với Discord: chọn output là `CABLE Input` (Windows) / `BlackHole 2ch` (macOS), trong Discord chọn micro là
  `CABLE Output` / `BlackHole 2ch`.

## 5. Thời gian train RVC (10 phút audio × 1 preset)

Phase 0 chỉ đo, không viết code train. Dùng [Applio](https://github.com/IAHispano/Applio) (MIT, bản fork RVC còn bảo trì,
không phụ thuộc fairseq) ở **một release cố định** — ghi tag/commit vào REPORT.md. Cài theo hướng dẫn của Applio
trong một venv **riêng** (không dùng chung venv spike).

Đặt 10 phút audio sạch vào `spikes/data/giong_10phut/`, rồi bọc từng bước bằng `time_cmd.py`.
Tên lệnh/tham số dưới đây chỉ là ví dụ — **đối chiếu bằng `python core.py <lệnh> --help` của đúng bản đã cài**:

```bash
APPLIO=/đường/dẫn/Applio
python time_cmd.py --label preprocess --dataset data/giong_10phut --cwd $APPLIO -- \
  $APPLIO/.venv/bin/python core.py preprocess --model_name spike10 --dataset_path <abs>/data/giong_10phut --sample_rate 40000
python time_cmd.py --label extract --cwd $APPLIO -- \
  $APPLIO/.venv/bin/python core.py extract --model_name spike10 --f0_method rmvpe --sample_rate 40000
python time_cmd.py --label train --cwd $APPLIO -- \
  $APPLIO/.venv/bin/python core.py train --model_name spike10 --total_epoch 200 --batch_size 8 --sample_rate 40000
python time_cmd.py --label index --cwd $APPLIO -- \
  $APPLIO/.venv/bin/python core.py index --model_name spike10
```

Ghi lại: số epoch / batch size dùng làm preset "Cân bằng", thời gian từng bước, VRAM đỉnh, và nghe thử model ra được
(dùng luôn làm model cho mục 4). Trên Mac ghi rõ nếu Applio không train được bằng MPS.

## 6. Nghiệm thu

Điền `REPORT.md` từ các file trong `results/` + nhận xét nghe thử, và `LICENSES_CHECK.md`.
Commit `results/*.json` cùng REPORT (không commit model hay audio).
