"""Tiện ích dùng chung cho các spike Phase 0: chọn device, đo thời gian, đo bộ nhớ GPU, ghi kết quả.

Spike là code thử nghiệm, không đưa vào app. Kết quả ghi ra spikes/results/*.json để tổng hợp vào REPORT.md.
"""

from __future__ import annotations

import json
import platform
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

import numpy as np

SPIKES_DIR = Path(__file__).resolve().parent
REPO_ROOT = SPIKES_DIR.parent
RESULTS_DIR = SPIKES_DIR / "results"
OUT_DIR = SPIKES_DIR / "out"
MODELS_DIR = SPIKES_DIR / "models"

# Code RVC vendored nằm trong engine/third_party (quy tắc mục 10 của spec).
THIRD_PARTY_DIR = REPO_ROOT / "engine" / "third_party"
if str(THIRD_PARTY_DIR) not in sys.path:
    sys.path.insert(0, str(THIRD_PARTY_DIR))


def pick_device(requested: str = "auto") -> str:
    import torch

    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def sync(device: str) -> None:
    """Chờ GPU chạy xong để số đo thời gian chính xác."""
    import torch

    if device.startswith("cuda"):
        torch.cuda.synchronize()
    elif device == "mps":
        torch.mps.synchronize()


def reset_peak_memory(device: str) -> None:
    import torch

    if device.startswith("cuda"):
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()


def memory_snapshot(device: str) -> dict[str, float | None]:
    """Bộ nhớ GPU (MB). CUDA có số đỉnh chính xác; MPS chỉ có số hiện tại (gọi sau mỗi bước để lấy max)."""
    import torch

    mb = 1024 * 1024
    if device.startswith("cuda"):
        return {
            "allocated_mb": torch.cuda.memory_allocated() / mb,
            "peak_allocated_mb": torch.cuda.max_memory_allocated() / mb,
            "peak_reserved_mb": torch.cuda.max_memory_reserved() / mb,
        }
    if device == "mps":
        return {
            "allocated_mb": torch.mps.current_allocated_memory() / mb,
            "driver_allocated_mb": torch.mps.driver_allocated_memory() / mb,
        }
    return {}


def free_memory(device: str) -> None:
    import gc

    import torch

    gc.collect()
    if device.startswith("cuda"):
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()


@contextmanager
def timer(device: str) -> Iterator[dict[str, float]]:
    out: dict[str, float] = {}
    sync(device)
    t0 = time.perf_counter()
    try:
        yield out
    finally:
        sync(device)
        out["seconds"] = time.perf_counter() - t0


def system_info(device: str) -> dict[str, Any]:
    import torch

    info: dict[str, Any] = {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "device": device,
    }
    if device.startswith("cuda"):
        props = torch.cuda.get_device_properties(0)
        info["gpu"] = props.name
        info["vram_total_mb"] = props.total_memory / 1024 / 1024
        info["cuda"] = torch.version.cuda
    return info


def percentiles(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    arr = np.asarray(values, dtype=np.float64)
    return {
        "mean": float(arr.mean()),
        "p50": float(np.percentile(arr, 50)),
        "p95": float(np.percentile(arr, 95)),
        "max": float(arr.max()),
    }


@dataclass
class Results:
    """Gom số đo của một lần chạy spike rồi ghi ra spikes/results/<name>-<thời gian>.json."""

    name: str
    device: str
    params: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def save(self) -> Path:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = RESULTS_DIR / f"{self.name}-{stamp}.json"
        payload = {
            "name": self.name,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "system": system_info(self.device),
            "params": self.params,
            "metrics": self.metrics,
            "notes": self.notes,
        }
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\n[kết quả] {path}")
        return path


def load_audio(path: str | Path, target_sr: int) -> np.ndarray:
    """Đọc file audio thành float32 mono ở target_sr (spike: dùng librosa, app thật sẽ dùng audio_io.py)."""
    import librosa

    audio, _ = librosa.load(str(path), sr=target_sr, mono=True)
    return audio.astype(np.float32)


def resample(audio: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    if orig_sr == target_sr:
        return audio
    import librosa

    return librosa.resample(audio, orig_sr=orig_sr, target_sr=target_sr).astype(np.float32)
