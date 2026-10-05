"""Nhận dạng transcript cho đoạn ref bằng faster-whisper (chỉ khi người dùng không tự nhập)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from ...core.errors import EngineError


def _expose_torch_cuda_dlls() -> None:
    """Windows: CTranslate2 (faster-whisper) cần cublas64_12 / cudnn64_9 nhưng không tự tìm trong torch/lib.
    Torch bản CUDA đã kèm sẵn các DLL này → đưa thư mục đó vào PATH thay vì bắt người dùng cài CUDA Toolkit."""
    if sys.platform != "win32":
        return
    try:
        import torch
    except ImportError:
        return
    lib = Path(torch.__file__).parent / "lib"
    if (lib / "cublas64_12.dll").exists() and str(lib) not in os.environ.get("PATH", ""):
        os.environ["PATH"] = f"{lib}{os.pathsep}{os.environ.get('PATH', '')}"
        os.add_dll_directory(str(lib))


class Whisper:
    def __init__(self, model_dir: Path, device: str) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise EngineError("MODEL_MISSING", "faster-whisper chưa được cài") from exc
        cuda = device.startswith("cuda")
        if cuda:
            _expose_torch_cuda_dlls()
        self.model = WhisperModel(str(model_dir), device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8")

    def transcribe(self, path: Path, language: str | None) -> str:
        segments, _ = self.model.transcribe(str(path), language=language if language in ("vi", "en") else None,
                                            beam_size=5, vad_filter=True)
        return " ".join(s.text.strip() for s in segments).strip()

    def words(self, path: Path, language: str | None) -> list[tuple[float, float, str]]:
        """Từng từ kèm thời điểm bắt đầu / kết thúc (giây) — dùng để cắt ref dài khớp với transcript."""
        segments, _ = self.model.transcribe(str(path), language=language if language in ("vi", "en") else None,
                                            beam_size=5, vad_filter=True, word_timestamps=True)
        return [(w.start, w.end, w.word) for s in segments for w in (s.words or [])]
