"""Kiểm tra logic chia đoạn (offline) và SOLA/crossfade (real-time) bằng converter giả = resample thuần.

Nếu framing đúng, output phải trùng với input (sau khi bù độ trễ) — không cần model hay GPU.
Chạy: cd spikes && python -m pytest tests -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rvc_core import HOP_16K, SR_16K, ConvertParams  # noqa: E402
from rvc_offline_spike import convert_long  # noqa: E402
from rvc_realtime_spike import RealtimeConfig, RealtimeVC  # noqa: E402


class IdentityConverter:
    """Giả lập RVCConverter: 'đổi giọng' = resample 16 kHz → tgt_sr, giữ đúng quy ước độ dài khung."""

    device = "cpu"

    def __init__(self, tgt_sr: int = 40000):
        self.tgt_sr = tgt_sr
        self.tgt_hop = tgt_sr // 100

    def convert(self, audio16k, params, return_frames=None):
        import torchaudio.functional as AF

        p_len = len(audio16k) // HOP_16K
        y = AF.resample(torch.from_numpy(audio16k[: p_len * HOP_16K]), SR_16K, self.tgt_sr).numpy()
        y = y[: p_len * self.tgt_hop]
        if return_frames is not None:
            y = y[-return_frames * self.tgt_hop:]
        return y


def voice_like(sr: int, seconds: float) -> np.ndarray:
    t = np.arange(int(sr * seconds)) / sr
    f0 = 140 + 30 * np.sin(2 * np.pi * 0.5 * t)
    ph = 2 * np.pi * np.cumsum(f0) / sr
    return (sum(np.sin(k * ph) / k for k in range(1, 6)) * 0.2).astype(np.float32)


def test_offline_chunks_reassemble_seamlessly():
    import torchaudio.functional as AF

    conv = IdentityConverter()
    x = voice_like(SR_16K, 7.3)
    y = convert_long(conv, x, ConvertParams(), chunk_sec=2.0, pad_sec=0.5, xfade_sec=0.05)
    ref = AF.resample(torch.from_numpy(x), SR_16K, conv.tgt_sr).numpy()
    assert len(y) == round(len(x) * conv.tgt_hop / HOP_16K)
    inner = slice(2000, len(y) - 2000)  # bỏ mép file (resample có hiệu ứng biên)
    assert np.max(np.abs(y[inner] - ref[inner])) < 1e-3


@pytest.mark.parametrize("block_ms", [100, 160, 250])
def test_realtime_sola_output_matches_delayed_input(block_ms):
    sr = 48000
    rt = RealtimeVC(IdentityConverter(), RealtimeConfig(sr=sr, block_ms=block_ms, context_s=0.5, crossfade_ms=60))
    x = voice_like(sr, 4.0)
    n = len(x) // rt.block
    y = np.concatenate([rt.process(x[i * rt.block:(i + 1) * rt.block]) for i in range(n)])
    x = x[: len(y)]

    skip = rt.total  # bỏ giai đoạn buffer còn rỗng
    max_lag = rt.sola_buffer + rt.sola_search
    errs = [np.mean(np.abs(y[skip:] - x[skip - lag: len(x) - lag])) for lag in range(max_lag + 1)]
    lag = int(np.argmin(errs))
    assert lag <= max_lag
    assert errs[lag] < 5e-3
    # Không có tiếng click: bước nhảy giữa hai mẫu liền kề không lớn hơn nhiều so với tín hiệu gốc.
    assert np.max(np.abs(np.diff(y[skip:]))) < 2 * np.max(np.abs(np.diff(x))) + 1e-3
