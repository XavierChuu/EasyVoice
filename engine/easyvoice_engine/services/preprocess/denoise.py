"""Khử nhiễu nhẹ (spectral gating) trước khi huấn luyện. Không có thư viện thì bỏ qua.

Xử lý theo cửa sổ 20 s có crossfade: noisereduce tốn bộ nhớ tỉ lệ với độ dài đoạn (≈ 0,5 GB cho 24 s),
chạy cả file 30 phút một lần sẽ hết RAM."""

from __future__ import annotations

import numpy as np

WINDOW_SEC, FADE_SEC = 20.0, 0.5


def light_denoise(audio: np.ndarray, sr: int, strength: float = 0.5) -> tuple[np.ndarray, bool]:
    try:
        import noisereduce
    except ImportError:
        return audio, False
    win, fade = int(WINDOW_SEC * sr), int(FADE_SEC * sr)
    if len(audio) <= win:
        return np.asarray(noisereduce.reduce_noise(y=audio, sr=sr, stationary=False, prop_decrease=strength), np.float32), True
    out = np.zeros_like(audio, dtype=np.float32)
    weight = np.zeros_like(audio, dtype=np.float32)
    ramp = np.linspace(0, 1, fade, dtype=np.float32)
    for start in range(0, len(audio), win - fade):
        seg = audio[start: start + win]
        y = np.asarray(noisereduce.reduce_noise(y=seg, sr=sr, stationary=False, prop_decrease=strength), np.float32)
        w = np.ones(len(y), np.float32)
        if start > 0:
            w[:fade] = ramp[: len(w[:fade])]
        if start + win < len(audio):
            w[-fade:] = ramp[::-1][-len(w[-fade:]):]
        out[start: start + len(y)] += y * w
        weight[start: start + len(y)] += w
        if start + win >= len(audio):
            break
    return out / np.maximum(weight, 1e-6), True
