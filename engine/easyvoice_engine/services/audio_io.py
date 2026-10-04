"""Vào/ra audio. Quy ước (spec mục 4): bên trong engine luôn là float32 mono; resample CHỈ ở đây."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from ..core.errors import EngineError


def ffmpeg_bin() -> str | None:
    return os.environ.get("EASYVOICE_FFMPEG") or shutil.which("ffmpeg")


def resample(audio: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    if orig_sr == target_sr or audio.size == 0:
        return audio.astype(np.float32, copy=False)
    import soxr

    return soxr.resample(audio, orig_sr, target_sr, quality="HQ").astype(np.float32)


def to_mono(audio: np.ndarray) -> np.ndarray:
    return audio.mean(axis=1).astype(np.float32) if audio.ndim > 1 else audio.astype(np.float32)


def _decode_ffmpeg(path: Path) -> tuple[np.ndarray, int]:
    exe = ffmpeg_bin()
    if not exe:
        raise EngineError("BAD_FILE", f"{path.name}: cần FFmpeg để đọc định dạng này")
    proc = subprocess.run(
        [exe, "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
        capture_output=True, check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise EngineError("BAD_FILE", f"{path.name}: {proc.stderr.decode(errors='ignore')[-200:]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy(), 48000


def load(path: str | Path, target_sr: int | None = None) -> tuple[np.ndarray, int]:
    """Đọc audio/video bất kỳ → float32 mono. Trả (audio, sr) — sr = target_sr nếu có."""
    path = Path(path)
    try:
        data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    except (RuntimeError, sf.LibsndfileError):
        data, sr = _decode_ffmpeg(path)
    audio = to_mono(np.asarray(data))
    if target_sr:
        audio, sr = resample(audio, sr, target_sr), target_sr
    return audio, int(sr)


def info(path: str | Path) -> tuple[float, int, int]:
    """(duration_sec, sample_rate, channels)."""
    try:
        i = sf.info(str(path))
        return float(i.duration), int(i.samplerate), int(i.channels)
    except (RuntimeError, sf.LibsndfileError):
        audio, sr = _decode_ffmpeg(Path(path))
        return len(audio) / sr, sr, 1


def save(path: str | Path, audio: np.ndarray, sr: int) -> Path:
    """Ghi theo đuôi file: .wav/.flac (soundfile), .mp3 (qua FFmpeg)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = np.clip(audio.astype(np.float32), -1.0, 1.0)
    if path.suffix.lower() == ".mp3":
        exe = ffmpeg_bin()
        if not exe:
            raise EngineError("BAD_REQUEST", "Xuất MP3 cần FFmpeg")
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "in.wav"
            sf.write(wav, audio, sr, subtype="PCM_16")
            proc = subprocess.run([exe, "-v", "error", "-y", "-i", str(wav), "-b:a", "192k", str(path)], capture_output=True)
            if proc.returncode != 0:
                raise EngineError("UNKNOWN", proc.stderr.decode(errors="ignore")[-200:])
        return path
    sf.write(path, audio, sr, subtype="PCM_16")
    return path


def peak_normalize(audio: np.ndarray, peak: float = 0.99) -> np.ndarray:
    m = float(np.max(np.abs(audio))) if audio.size else 0.0
    return audio * (peak / m) if m > peak else audio


def crossfade_concat(parts: list[np.ndarray], sr: int, pause_ms: int = 0, fade_ms: int = 15) -> np.ndarray:
    """Ghép các đoạn: chèn khoảng lặng pause_ms, fade in/out ngắn ở mép mỗi đoạn để không có tiếng click."""
    if not parts:
        return np.zeros(0, dtype=np.float32)
    fade = max(1, int(sr * fade_ms / 1000))
    gap = np.zeros(int(sr * pause_ms / 1000), dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    out: list[np.ndarray] = []
    for i, p in enumerate(parts):
        p = p.astype(np.float32).copy()
        n = min(fade, len(p) // 2)
        if n:
            p[:n] *= ramp[:n]
            p[-n:] *= ramp[:n][::-1]
        out.append(p)
        if i < len(parts) - 1 and gap.size:
            out.append(gap)
    return np.concatenate(out)


def srt(durations: list[float], texts: list[str], pause_ms: int = 0) -> str:
    def ts(t: float) -> str:
        ms = int(round(t * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"

    lines, t = [], 0.0
    for i, (d, text) in enumerate(zip(durations, texts), 1):
        lines += [str(i), f"{ts(t)} --> {ts(t + d)}", text, ""]
        t += d + pause_ms / 1000
    return "\n".join(lines)
