# third_party/rvc — code RVC v2 (vendored)

Chỉ phần **suy luận**: kiến trúc synthesizer (`models.py` + phụ thuộc) và bộ ước lượng F0 `rmvpe.py`.
Không chứa code train — train trong Phase 0 chạy bằng công cụ ngoài (xem `spikes/README.md`).

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

Logic của app không được đặt trong thư mục này (quy tắc mục 10 của spec).
