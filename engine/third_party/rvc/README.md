# third_party/rvc — code RVC v2 (vendored)

Kiến trúc synthesizer + discriminator (`models.py` + phụ thuộc), bộ ước lượng F0 `rmvpe.py`, và phần phụ trợ
cho train: `losses.py`, `mel_processing.py`, `slicer2.py`. Vòng lặp train là code của app
(`easyvoice_engine/services/rvc/train/`), không nằm ở đây.

| | |
|---|---|
| Nguồn gốc | [RVC-Project/Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) (MIT) |
| Lấy qua | gói PyPI `rvc-python==0.1.5` (MIT, © 2023 Danil Boldyrev), thư mục `rvc_python/lib/` |
| Commit gốc upstream | **chưa xác định** — Phase 0 phải đối chiếu với repo RVC và ghi commit vào đây |
| License | MIT — xem `LICENSE.rvc-python` |

## Thay đổi so với bản gốc
- `infer_pack/*.py` → đặt phẳng trong thư mục này, import đổi sang tương đối (`from . import ...`).
- `rmvpe.py`: bỏ nhánh JIT, Intel IPEX, DirectML/ONNX và đoạn demo `__main__`;
  `torch.load(..., weights_only=True)`; `model_path=None` cho phép khởi tạo ngẫu nhiên (dùng cho test).
- Không sửa logic tính toán.

### `losses.py`, `mel_processing.py`, `slicer2.py`
| | |
|---|---|
| Lấy qua | gói PyPI `rvc==0.3.5` (RVC-Project/Retrieval-based-Voice-Conversion, MIT, © 2023 liujing04) — `rvc/lib/train/`, `rvc/lib/slicer2.py` |
| License | MIT — xem `LICENSE.rvc` |
| Thay đổi | `mel_processing.spectrogram_torch`: `torch.stft(return_complex=True)` + tính biên độ từ phần thực/ảo (torch mới bỏ `return_complex=False`). Không đổi công thức. |

Logic của app không được đặt trong thư mục này (quy tắc mục 10 của spec).
