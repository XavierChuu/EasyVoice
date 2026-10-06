"""Lỗi luôn có mã + thông điệp tiếng Việt dễ hiểu (spec mục 5). UI dịch lại theo mã."""

from __future__ import annotations

MESSAGES: dict[str, tuple[str, str]] = {
    "GPU_BUSY_REALTIME": ("Đổi giọng trực tiếp đang giữ GPU. Hãy dừng nó trước.", "Real-time is holding the GPU. Stop it first."),
    "GPU_BUSY_JOB": ("Một tác vụ khác đang dùng GPU.", "Another job is using the GPU."),
    "GPU_OOM": ("Hết bộ nhớ GPU, hãy đóng tác vụ khác rồi thử lại.", "Out of GPU memory. Close other tasks and try again."),
    "NO_STS_VOICE": ("Giọng này chưa có model RVC.", "This voice has no RVC model."),
    "UNSAFE_MODEL": ("File chứa mã thực thi, không chỉ là trọng số model. Không có gì được nhập.",
                     "The file contains executable code, not just weights. Nothing was imported."),
    "BAD_FILE": ("Không đọc được file hoặc định dạng không hỗ trợ.", "Could not read the file or the format is not supported."),
    "BAD_REQUEST": ("Yêu cầu không hợp lệ.", "Invalid request."),
    "NOT_FOUND": ("Không tìm thấy.", "Not found."),
    "MODEL_MISSING": ("Thiếu model cần thiết. Hãy tải model trong màn hình thiết lập.", "A required model is not installed."),
    "NOT_IMPLEMENTED": ("Tính năng này chưa có trong phiên bản engine hiện tại.", "This feature is not available in this engine version yet."),
    "UNAUTHORIZED": ("Thiếu hoặc sai token.", "Missing or wrong token."),
    "GPU_REQUIRED": ("Huấn luyện giọng cần GPU NVIDIA hoặc Apple Silicon.", "Voice training needs an NVIDIA GPU or Apple Silicon."),
    "DOWNLOAD_FAILED": ("Không tải được một số model.", "Some models could not be downloaded."),
    "REALTIME_GPU": ("Đổi giọng trực tiếp cần GPU NVIDIA hoặc Apple Silicon.", "Live voice changing needs an NVIDIA GPU or Apple Silicon."),
    "AUDIO_DEVICE": ("Không mở được thiết bị âm thanh. Kiểm tra micro / loa đã cắm và không bị ứng dụng khác giữ.",
                     "Could not open the audio device. Check that the mic / output is connected and not held by another app."),
    "CANCELLED": ("Đã hủy.", "Cancelled."),
    "UNKNOWN": ("Đã có lỗi xảy ra. Chi tiết đã được ghi vào file log.", "Something went wrong. Details were written to the log."),
}

STATUS: dict[str, int] = {
    "BAD_FILE": 400, "BAD_REQUEST": 400, "UNSAFE_MODEL": 400, "NO_STS_VOICE": 400, "UNAUTHORIZED": 401,
    "NOT_FOUND": 404, "GPU_BUSY_REALTIME": 409, "GPU_BUSY_JOB": 409, "MODEL_MISSING": 424,
    "NOT_IMPLEMENTED": 501, "DOWNLOAD_FAILED": 502, "GPU_OOM": 507, "GPU_REQUIRED": 409, "REALTIME_GPU": 409, "AUDIO_DEVICE": 400,
}


class EngineError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code if code in MESSAGES else "UNKNOWN"
        self.detail = detail

    @property
    def status(self) -> int:
        return STATUS.get(self.code, 500)

    def to_dict(self) -> dict[str, str]:
        vi, en = MESSAGES[self.code]
        return {"code": self.code, "message": vi, "messageEn": en, "detail": self.detail}


def from_exception(exc: BaseException) -> EngineError:
    """Quy đổi lỗi bất kỳ về EngineError (OOM của torch → GPU_OOM)."""
    if isinstance(exc, EngineError):
        return exc
    text = str(exc)
    if "out of memory" in text.lower():
        return EngineError("GPU_OOM", text[:300])
    return EngineError("UNKNOWN", f"{type(exc).__name__}: {text[:300]}")
