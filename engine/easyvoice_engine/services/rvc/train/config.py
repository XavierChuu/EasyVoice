"""Cấu hình huấn luyện RVC v2 (theo configs/v2/40k.json của RVC-Project) và preset Nhanh / Cân bằng / Kỹ (spec 3.1)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Preset = Literal["fast", "balanced", "thorough"]

# Người dùng chọn preset thay vì nhập epoch (spec). Số epoch chốt lại sau khi đo ở Phase 0.
PRESET_EPOCHS: dict[str, int] = {"fast": 100, "balanced": 200, "thorough": 400}


@dataclass(frozen=True)
class TrainConfig:
    sample_rate: int = 40000
    filter_length: int = 2048
    hop_length: int = 400
    win_length: int = 2048
    n_mel_channels: int = 125
    mel_fmin: float = 0.0
    mel_fmax: float | None = None
    segment_size: int = 12800
    learning_rate: float = 1e-4
    betas: tuple[float, float] = (0.8, 0.99)
    eps: float = 1e-9
    lr_decay: float = 0.999875
    c_mel: float = 45.0
    c_kl: float = 1.0
    batch_size: int = 8
    max_frames: int = 900  # đoạn dài hơn bị cắt (RVC: 900 khung 10 ms)
    upsample_rates: list[int] = field(default_factory=lambda: [10, 10, 2, 2])
    upsample_kernel_sizes: list[int] = field(default_factory=lambda: [16, 16, 4, 4])

    def synth_config(self) -> list:
        """Danh sách tham số khởi tạo SynthesizerTrnMs768NSFsid — cũng là "config" lưu trong rvc.json."""
        return [self.filter_length // 2 + 1, self.segment_size // self.hop_length, 192, 192, 768, 2, 6, 3, 0, "1",
                [3, 7, 11], [[1, 3, 5]] * 3, list(self.upsample_rates), 512, list(self.upsample_kernel_sizes),
                109, 256, self.sample_rate]


CONFIG_40K = TrainConfig()


def auto_batch_size(device: str) -> int:
    """Batch theo bộ nhớ GPU: cấu hình tối thiểu của spec là 6 GB VRAM, batch 8 sẽ tràn bộ nhớ ở đó."""
    if device.startswith("cuda"):
        import torch

        total_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
        return 4 if total_gb < 8 else 6 if total_gb < 12 else 8
    return 4 if device == "mps" else 2
