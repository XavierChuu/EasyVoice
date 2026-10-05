"""Tách giọng khỏi nhạc nền bằng Demucs htdemucs (MIT), nạp từ thư mục model local — không tự tải từ internet."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np

from ...core.errors import EngineError
from .. import audio_io

HTDEMUCS_SIG = "955717e8"


class Separator:
    def __init__(self, model_dir: Path, device: str) -> None:
        try:
            from demucs.pretrained import get_model
        except ImportError as exc:
            raise EngineError("MODEL_MISSING", "demucs chưa được cài") from exc
        bag = model_dir / "htdemucs.yaml"
        if not bag.exists():  # file mô tả "bag" — nội dung cố định, không cần tải
            bag.write_text(f"models: ['{HTDEMUCS_SIG}']\n", encoding="utf-8")
        self.model = get_model("htdemucs", repo=model_dir).eval().to(device)
        self.device = device
        self.sr = int(self.model.samplerate)

    def separate(self, audio: np.ndarray, sr: int, on_progress: Callable[[float], None] | None = None
                 ) -> tuple[np.ndarray, np.ndarray]:
        """Trả (giọng, nhạc nền) — mono float32 ở sample rate đầu vào."""
        import torch
        from demucs.apply import apply_model

        x = audio_io.resample(audio, sr, self.sr)
        wav = torch.from_numpy(np.stack([x, x]))
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        wav = (wav - mean) / std
        with torch.no_grad():
            src = apply_model(self.model, wav[None], device=self.device, split=True, overlap=0.25, progress=False)[0]
        src = src * std + mean
        vi = self.model.sources.index("vocals")
        vocals = src[vi].mean(0).cpu().numpy()
        acc = (src.sum(0) - src[vi]).mean(0).cpu().numpy()
        if on_progress:
            on_progress(1.0)
        return audio_io.resample(vocals, self.sr, sr), audio_io.resample(acc, self.sr, sr)
