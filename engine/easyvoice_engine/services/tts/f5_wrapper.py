"""Bọc F5-TTS (spec: chỉ dùng checkpoint có sẵn, không train F5). App gọi qua interface TtsBackend để có thể
thay model khác cho bản trả phí (ADR-0001) và để test không cần GPU/model."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol

import numpy as np

from ...core.errors import EngineError

log = logging.getLogger(__name__)


class TtsBackend(Protocol):
    sample_rate: int

    def synthesize(self, text: str, ref_audio: Path, ref_text: str, speed: float, seed: int) -> np.ndarray: ...


class F5Backend:
    """arch: cấu hình kiến trúc của checkpoint (F5TTS_v1_Base cho bản gốc, F5TTS_Base cho nhiều bản fine-tune cũ)."""

    def __init__(self, device: str, ckpt: Path, vocab: Path | None, arch: str, vocoder_dir: Path, nfe_step: int = 32) -> None:
        try:
            from f5_tts.api import F5TTS
        except ImportError as exc:
            raise EngineError("MODEL_MISSING", f"f5-tts chưa được cài: {exc}") from exc
        for p in (ckpt, vocoder_dir / "config.yaml", vocoder_dir / "pytorch_model.bin"):
            if not p.exists():
                raise EngineError("MODEL_MISSING", str(p))
        self.nfe_step = nfe_step
        self._tts = F5TTS(model=arch, ckpt_file=str(ckpt), vocab_file=str(vocab) if vocab else "",
                          vocoder_local_path=str(vocoder_dir), device=device)
        self.sample_rate = int(self._tts.target_sample_rate)

    def synthesize(self, text: str, ref_audio: Path, ref_text: str, speed: float, seed: int) -> np.ndarray:
        wav, _sr, _spec = self._tts.infer(
            str(ref_audio), ref_text, text, speed=speed, seed=seed, nfe_step=self.nfe_step, show_info=lambda *a: None,
        )
        return np.asarray(wav, dtype=np.float32)
