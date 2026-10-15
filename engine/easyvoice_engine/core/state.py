"""Trạng thái dùng chung của engine: đường dẫn, settings, ModelManager, JobQueue, kho giọng, file kết quả, sự kiện."""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import __version__
from ..services.edit.store import EditStore
from ..services.models import ModelCatalog
from ..services.voices import VoiceStore
from .device import fp16_ok, pick_device
from .job_queue import Job, JobQueue
from .model_manager import ModelManager
from .paths import Paths
from .settings import Settings

log = logging.getLogger(__name__)


class Hub:
    """Đẩy sự kiện từ thread bất kỳ tới các kết nối WebSocket (asyncio)."""

    def __init__(self) -> None:
        self._subs: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self._lock = threading.Lock()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._subs.append((asyncio.get_running_loop(), q))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs = [(lp, x) for lp, x in self._subs if x is not q]

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs)
        for loop, q in subs:
            try:
                loop.call_soon_threadsafe(q.put_nowait, event)
            except (RuntimeError, asyncio.QueueFull):
                pass


@dataclass
class ImportStaging:
    dir: Path
    index: Path | None
    meta: dict
    name: str
    kind: str = "rvc"  # "rvc" (.pth đã chuyển) | "evoice" (dir/files = nội dung đã giải nén, meta = manifest)


@dataclass
class EngineState:
    paths: Paths
    settings: Settings
    token: str
    version: str = __version__
    hub: Hub = field(default_factory=Hub)
    files: dict[str, tuple[Path, str]] = field(default_factory=dict)
    extras: dict[str, Any] = field(default_factory=dict)  # tts render, input STS, import tạm theo job/token
    imports: dict[str, ImportStaging] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.models = ModelManager(self.device)
        self.queue = JobQueue(self.device)
        self.catalog = ModelCatalog(self.paths.models)
        self.voices = VoiceStore(self.paths.voices, on_change=self.publish_voices)
        self.edit = EditStore(self.paths.root / "projects")
        self.queue.subscribe(lambda job: self.hub.publish({"type": "job", "job": job.model_dump(by_alias=True)}))
        from ..services.registry import register_default_models

        register_default_models(self)

    @classmethod
    def create(cls, token: str, root: Path | None = None) -> "EngineState":
        base = Paths.create(root)
        settings = Settings.load(base.settings_file)
        paths = Paths.create(base.root, settings.models_dir, settings.voices_dir)
        return cls(paths=paths, settings=settings, token=token)

    def device(self) -> str:
        return pick_device(self.settings.device)

    def half(self) -> bool:
        return fp16_ok(self.device())

    def register_file(self, path: Path, name: str) -> str:
        fid = uuid.uuid4().hex[:16]
        self.files[fid] = (path, name)
        return fid

    def publish_voices(self) -> None:
        voices = [self.voices.to_api(p).model_dump(by_alias=True) for p in self.voices.list()]
        self.hub.publish({"type": "voices", "voices": voices})

    def job_dir(self, job: Job) -> Path:
        d = self.paths.jobs / job.id
        d.mkdir(parents=True, exist_ok=True)
        return d
