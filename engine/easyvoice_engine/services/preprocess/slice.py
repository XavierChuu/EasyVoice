"""Cắt dataset theo khoảng lặng rồi chia đoạn ~3.7 s có chồng lấn 0.3 s, chuẩn hóa biên độ (theo cách RVC tiền xử lý)."""

from __future__ import annotations

import numpy as np
from scipy import signal

from ..rvc import THIRD_PARTY  # noqa: F401  (import được rvc.slicer2)

SEG_SEC, OVERLAP_SEC = 3.7, 0.3
MAX_AMP, ALPHA = 0.9, 0.75


def high_pass(audio: np.ndarray, sr: int) -> np.ndarray:
    b, a = signal.butter(N=5, Wn=48, btype="high", fs=sr)
    return signal.filtfilt(b, a, audio).astype(np.float32)


def speech_chunks(audio: np.ndarray, sr: int) -> list[np.ndarray]:
    """Các đoạn có tiếng nói (bỏ khoảng lặng dài)."""
    from rvc.slicer2 import Slicer

    slicer = Slicer(sr=sr, threshold=-42, min_length=1500, min_interval=400, hop_size=15, max_sil_kept=500)
    return [np.asarray(c, dtype=np.float32) for c in slicer.slice(audio)]


def _norm(seg: np.ndarray) -> np.ndarray | None:
    peak = float(np.abs(seg).max()) if seg.size else 0.0
    if peak <= 1e-4 or peak > 2.5:  # im lặng hoặc lỗi biên độ: bỏ
        return None
    return (seg / peak * (MAX_AMP * ALPHA) + (1 - ALPHA) * seg).astype(np.float32)


def segments(chunk: np.ndarray, sr: int) -> list[np.ndarray]:
    out: list[np.ndarray] = []
    step = int(sr * (SEG_SEC - OVERLAP_SEC))
    seg_len = int(sr * SEG_SEC)
    i = 0
    while True:
        start = step * i
        i += 1
        rest = chunk[start:]
        if len(rest) > int(sr * (SEG_SEC + OVERLAP_SEC)):
            seg = _norm(rest[:seg_len])
        else:
            seg = _norm(rest) if len(rest) > int(0.6 * sr) else None
            if seg is not None:
                out.append(seg)
            break
        if seg is not None:
            out.append(seg)
    return out


def pick_reference(chunks: list[np.ndarray], sr: int) -> np.ndarray | None:
    """Chọn đoạn sạch 5-12 s (ưu tiên ~8 s, năng lượng ổn định) làm ref cho TTS zero-shot."""
    best, best_score = None, -1e9
    for c in chunks:
        dur = len(c) / sr
        if not 5.0 <= dur <= 12.0:
            continue
        frame = sr // 50
        n = len(c) // frame
        rms = np.sqrt(np.mean(c[: n * frame].reshape(n, frame) ** 2, axis=1)) + 1e-9
        db = 20 * np.log10(rms)
        score = float(np.median(db)) - float(np.std(db)) * 0.3 - abs(dur - 8.0)
        if score > best_score:
            best, best_score = c, score
    return best
