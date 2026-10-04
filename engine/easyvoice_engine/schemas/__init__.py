"""Schema request/response (Pydantic). JSON dùng camelCase để types TypeScript sinh từ OpenAPI khớp với UI."""

from __future__ import annotations

from typing import Literal

from ..core.job_queue import ApiModel, Job, TtsSentence  # noqa: F401
from ..services.models import ModelInfo  # noqa: F401
from ..services.voices import Profile, RefAnalysis  # noqa: F401


class Health(ApiModel):
    status: Literal["ok"] = "ok"
    version: str


class SystemInfo(ApiModel):
    app_version: str
    gpu: str
    device: str
    vram_total_gb: float
    vram_used_gb: float
    disk_free_gb: float
    driver_ok: bool
    realtime: bool
    loaded_models: list[str]
    models: list[ModelInfo]


class JobRef(ApiModel):
    job_id: str


class DownloadRequest(ApiModel):
    ids: list[str]


class RenameRequest(ApiModel):
    name: str


class Transcript(ApiModel):
    text: str


class TtsRequest(ApiModel):
    profile_id: str
    text: str
    mode: Literal["direct", "chain"] = "direct"
    speed: float = 1.0
    seed: int = 1234
    pause_ms: int = 250
    user_dict: list[tuple[str, str]] = []


class RedoRequest(ApiModel):
    index: int


class ImportCheck(ApiModel):
    key: str
    value: str
    bad: bool = False


class ImportInspection(ApiModel):
    token: str
    kind: Literal["evoice", "rvc"]
    file_label: str
    blocked: bool
    checks: list[ImportCheck]
    suggested_name: str
    author: str
    language: Literal["vi", "en", "unknown"]
    license: Literal["personal", "commercial", "noredist", "unknown"]
    capabilities: list[Literal["tts", "sts"]]
    created_at: str | None = None
    sample_rate: int


class ImportRequest(ApiModel):
    token: str
    name: str


class AudioDevice(ApiModel):
    id: str
    name: str
    virtual: bool


class AudioDevices(ApiModel):
    inputs: list[AudioDevice]
    outputs: list[AudioDevice]


class ErrorBody(ApiModel):
    code: str
    message: str
    message_en: str
    detail: str
