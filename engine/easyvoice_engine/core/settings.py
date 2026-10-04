"""settings.json trong thư mục dữ liệu."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel


class Settings(BaseModel):
    device: Literal["auto", "gpu", "cpu"] = "auto"
    models_dir: str = ""
    voices_dir: str = ""
    # Checkpoint F5-TTS: id trong models.manifest.json (mặc định bản gốc, tiếng Anh) — chốt bản tiếng Việt sau Phase 0.
    tts_model: str = "f5tts-v1-base"

    @classmethod
    def load(cls, path: Path) -> "Settings":
        if path.exists():
            try:
                return cls.model_validate_json(path.read_text(encoding="utf-8"))
            except ValueError:
                pass
        return cls()

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(self.model_dump(), indent=2), encoding="utf-8")
