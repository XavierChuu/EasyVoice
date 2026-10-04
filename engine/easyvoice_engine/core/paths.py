"""Đường dẫn dữ liệu người dùng (spec mục 6) — không hardcode ở nơi khác.

Windows: %APPDATA%/EasyVoice; macOS: ~/Library/Application Support/EasyVoice; Linux (dev): ~/.local/share/EasyVoice.
Ghi đè bằng EASYVOICE_DATA_DIR. models/ và voices/ có thể chuyển sang ổ khác qua settings.json.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


def default_data_dir() -> Path:
    if env := os.environ.get("EASYVOICE_DATA_DIR"):
        return Path(env)
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "EasyVoice"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "EasyVoice"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "EasyVoice"


@dataclass(frozen=True)
class Paths:
    root: Path
    models: Path
    voices: Path

    @classmethod
    def create(cls, root: Path | None = None, models: str = "", voices: str = "") -> "Paths":
        root = root or default_data_dir()
        p = cls(root=root, models=Path(models) if models else root / "models", voices=Path(voices) if voices else root / "voices")
        for d in (p.root, p.models, p.voices, p.jobs, p.outputs, p.logs, p.tmp):
            d.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def jobs(self) -> Path:
        return self.root / "jobs"

    @property
    def outputs(self) -> Path:
        return self.root / "outputs"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def tmp(self) -> Path:
        return self.root / "tmp"

    @property
    def settings_file(self) -> Path:
        return self.root / "settings.json"
