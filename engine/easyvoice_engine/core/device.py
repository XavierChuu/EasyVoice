"""Chọn device và thông tin phần cứng. Mọi chỗ khác hỏi device qua đây, không tự đoán."""

from __future__ import annotations

import platform
import shutil
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def torch_available() -> bool:
    try:
        import torch  # noqa: F401
    except ImportError:
        return False
    return True


def _mps() -> bool:
    """[Mac Intel] MPS chỉ dùng trên Apple Silicon (Apple Silicon / CUDA không đổi). torch conda-forge cho Mac Intel (GPU AMD/Intel) cũng bật MPS nhưng chưa được
    kiểm chứng với các model của app → Mac Intel chạy CPU, khớp với bản runtime "cpu" của first-run."""
    import torch

    return platform.machine() == "arm64" and torch.backends.mps.is_available()


def pick_device(pref: str = "auto") -> str:
    if pref == "cpu" or not torch_available():
        return "cpu"
    import torch

    if torch.cuda.is_available():
        return "cuda:0"
    if _mps():
        return "mps"
    return "cpu"


@lru_cache(maxsize=1)
def gpu_name() -> str:
    if not torch_available():
        return "CPU"
    import torch

    if torch.cuda.is_available():
        return torch.cuda.get_device_name(0)
    if _mps():
        return "Apple Silicon (MPS)"
    return "CPU"


@dataclass
class Memory:
    total_gb: float
    used_gb: float


def memory(device: str) -> Memory:
    if device.startswith("cuda"):
        import torch

        free, total = torch.cuda.mem_get_info()
        return Memory(total / 1e9, (total - free) / 1e9)
    if device == "mps":
        import torch

        return Memory(0.0, torch.mps.driver_allocated_memory() / 1e9)
    return Memory(0.0, 0.0)


def empty_cache(device: str) -> None:
    if not torch_available():
        return
    import torch

    if device.startswith("cuda") and torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif device == "mps" and torch.backends.mps.is_available():
        torch.mps.empty_cache()


def disk_free_gb(path: Path) -> float:
    return shutil.disk_usage(path).free / 1e9
