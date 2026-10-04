"""ModelManager duy nhất (spec mục 5): registry model đang nạp, load lười, unload theo LRU khi đổi tác vụ,
gọi empty_cache sau khi giải phóng. Mọi model phải đi qua đây (quy tắc mục 10)."""

from __future__ import annotations

import gc
import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .device import empty_cache

log = logging.getLogger(__name__)

# Nhóm "shared" không bị gỡ khi đổi tác vụ (model nhỏ dùng chung). Các nhóm còn lại loại trừ nhau:
# nạp model nhóm "tts" sẽ gỡ model nhóm "rvc"/"train" và ngược lại → không bao giờ giữ TTS và train cùng lúc.
SHARED = "shared"


@dataclass
class _Entry:
    key: str
    group: str
    loader: Callable[[str], Any]


class ModelManager:
    def __init__(self, device: Callable[[], str]) -> None:
        self._device = device
        self._registry: dict[str, _Entry] = {}
        self._loaded: OrderedDict[str, tuple[str, Any]] = OrderedDict()  # key → (group, model), cũ nhất ở đầu
        self._lock = threading.RLock()

    def register(self, key: str, loader: Callable[[str], Any], group: str) -> None:
        with self._lock:
            if key in self._loaded:
                self.unload(key)
            self._registry[key] = _Entry(key, group, loader)

    def is_registered(self, key: str) -> bool:
        return key in self._registry

    def get(self, key: str) -> Any:
        with self._lock:
            if key in self._loaded:
                self._loaded.move_to_end(key)
                return self._loaded[key][1]
            entry = self._registry.get(key)
            if entry is None:
                raise KeyError(f"model not registered: {key}")
            others = [] if entry.group == SHARED else [k for k, (g, _) in self._loaded.items() if g not in (entry.group, SHARED)]
            for k in others:  # LRU: các model của tác vụ khác bị gỡ trước khi nạp
                self.unload(k)
            device = self._device()
            log.info("load model %s on %s", key, device)
            model = entry.loader(device)
            self._loaded[key] = (entry.group, model)
            return model

    def unload(self, key: str) -> None:
        with self._lock:
            item = self._loaded.pop(key, None)
            if item is None:
                return
            log.info("unload model %s", key)
            del item
            gc.collect()
            empty_cache(self._device())

    def unload_all(self) -> None:
        with self._lock:
            for k in list(self._loaded):
                self.unload(k)

    def loaded(self) -> list[str]:
        with self._lock:
            return list(self._loaded)
