"""Nhận dạng transcript cho đoạn ref bằng faster-whisper (chỉ khi người dùng không tự nhập)."""

from __future__ import annotations

from pathlib import Path

from ...core.errors import EngineError


class Whisper:
    def __init__(self, model_dir: Path, device: str) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise EngineError("MODEL_MISSING", "faster-whisper chưa được cài") from exc
        cuda = device.startswith("cuda")
        self.model = WhisperModel(str(model_dir), device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8")

    def transcribe(self, path: Path, language: str | None) -> str:
        segments, _ = self.model.transcribe(str(path), language=language if language in ("vi", "en") else None,
                                            beam_size=5, vad_filter=True)
        return " ".join(s.text.strip() for s in segments).strip()
