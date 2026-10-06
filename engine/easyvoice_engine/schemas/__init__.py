"""Schema request/response (Pydantic). JSON dùng camelCase để types TypeScript sinh từ OpenAPI khớp với UI."""

from __future__ import annotations

from typing import Literal

from ..core.job_queue import ApiModel, Job, TtsSentence  # noqa: F401
from ..services.models import ModelInfo  # noqa: F401
from ..services.voices import Profile, RefAnalysis, VariantInfo  # noqa: F401


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


class VoiceUpdate(ApiModel):
    """Chỉ trường nào gửi lên mới được đổi; gửi null cho thẻ = xóa thẻ."""

    name: str | None = None
    gender: Literal["male", "female", "other"] | None = None
    country: str | None = None
    region: str | None = None


class Transcript(ApiModel):
    text: str


class TtsPart(ApiModel):
    """Một đoạn văn bản đọc bằng giọng/biến thể riêng (người dùng bôi đen rồi chọn giọng)."""

    text: str
    profile_id: str
    variant_id: str | None = None


class TtsRequest(ApiModel):
    profile_id: str
    text: str
    variant_id: str | None = None  # None = giọng chuẩn
    # Bỏ trống = cả văn bản đọc bằng profile_id/variant_id. Có thì text = các part nối lại (UI tách sẵn).
    parts: list[TtsPart] = []
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


class ExportRequest(ApiModel):
    include_model: bool = True
    include_ref: bool = False
    license: Literal["personal", "commercial", "noredist"] = "personal"
    author: str = ""
    dest_dir: str | None = None  # thư mục lưu (app gửi thư mục Tải về); bỏ trống / không hợp lệ → outputs/


class ExportResult(ApiModel):
    path: str
    size_mb: float
    file_id: str  # tải về qua GET /files/{id} (khi app chạy trong trình duyệt)


class EngineSettings(ApiModel):
    device: Literal["auto", "gpu", "cpu"]
    models_dir: str  # "" = mặc định trong thư mục dữ liệu
    voices_dir: str
    active_models_dir: str  # thư mục engine đang dùng (đổi thư mục cần khởi động lại engine)
    active_voices_dir: str
    restart_required: bool


class SettingsUpdate(ApiModel):
    device: Literal["auto", "gpu", "cpu"] | None = None
    models_dir: str | None = None
    voices_dir: str | None = None
