"""Danh sách model (models.manifest.json: url, sha256, size, license) và downloader có kiểm sha256 + tải tiếp."""

from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from pathlib import Path

from pydantic import BaseModel

from ..core.errors import EngineError
from ..core.job_queue import ApiModel, JobContext

CHUNK = 1 << 20


class ManifestFile(BaseModel):
    path: str
    url: str
    sha256: str | None = None
    size_mb: float | None = None


class ManifestModel(BaseModel):
    id: str
    name: str
    role: str
    group: str  # tts | sts | common
    license: str
    commercial: bool | None = None
    required: bool = False
    arch: str | None = None
    languages: list[str] | None = None  # model TTS: ngôn ngữ đọc được (app cảnh báo khi văn bản ngoài danh sách)
    lowercase: bool = False  # model TTS train trên văn bản chữ thường
    files: list[ManifestFile]


class ModelInfo(ApiModel):
    id: str
    name: str
    role: str
    group: str
    size_mb: float
    license: str
    commercial: bool | None
    installed: bool
    required: bool
    languages: list[str] | None = None


def manifest_path() -> Path:
    if env := os.environ.get("EASYVOICE_MANIFEST"):
        return Path(env)
    return Path(__file__).resolve().parents[3] / "models.manifest.json"


class ModelCatalog:
    def __init__(self, models_dir: Path, manifest: Path | None = None) -> None:
        self.models_dir = models_dir
        data = json.loads((manifest or manifest_path()).read_text(encoding="utf-8"))
        self.models = {m["id"]: ManifestModel.model_validate(m) for m in data.get("models", [])}

    def get(self, model_id: str) -> ManifestModel:
        if model_id not in self.models:
            raise EngineError("MODEL_MISSING", f"model {model_id} không có trong manifest")
        return self.models[model_id]

    def path(self, model_id: str, index: int = 0) -> Path:
        return self.models_dir / self.get(model_id).files[index].path

    def dir(self, model_id: str) -> Path:
        return (self.models_dir / self.get(model_id).files[0].path).parent

    def installed(self, model_id: str) -> bool:
        return all((self.models_dir / f.path).exists() for f in self.get(model_id).files)

    def require(self, model_id: str) -> ManifestModel:
        m = self.get(model_id)
        missing = [f.path for f in m.files if not (self.models_dir / f.path).exists()]
        if missing:
            raise EngineError("MODEL_MISSING", f"{m.name}: thiếu {', '.join(missing)}")
        return m

    def info(self) -> list[ModelInfo]:
        return [ModelInfo(id=m.id, name=m.name, role=m.role, group=m.group, license=m.license, commercial=m.commercial,
                          required=m.required, installed=self.installed(m.id), languages=m.languages,
                          size_mb=sum(f.size_mb or 0 for f in m.files)) for m in self.models.values()]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def download_file(url: str, dest: Path, on_bytes=None, check=None) -> None:
    """Tải tiếp từ file .part nếu rớt mạng (HTTP Range)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(url, headers={"User-Agent": "EasyVoice"})
    if have:
        req.add_header("Range", f"bytes={have}-")
    if (token := os.environ.get("HF_TOKEN")) and "huggingface.co" in url:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as resp:
        if have and resp.status != 206:
            have = 0
        mode = "ab" if have else "wb"
        with part.open(mode) as f:
            if on_bytes and have:
                on_bytes(have)
            while block := resp.read(CHUNK):
                if check:
                    check()
                f.write(block)
                if on_bytes:
                    on_bytes(len(block))
    part.replace(dest)


def run_download(ctx: JobContext, catalog: ModelCatalog, ids: list[str]) -> None:
    files = [(m, f) for mid in ids for m in [catalog.get(mid)] for f in m.files if not (catalog.models_dir / f.path).exists()]
    total = sum((f.size_mb or 1) * 1e6 for _, f in files) or 1.0
    done = 0.0

    def on_bytes(n: int) -> None:
        nonlocal done
        done += n
        ctx.progress(min(0.999, done / total))

    for m, f in files:
        dest = catalog.models_dir / f.path
        ctx.log(f"Tải {m.name}: {f.path}")
        download_file(f.url, dest, on_bytes, ctx.check_cancel)
        if f.sha256:
            digest = sha256_of(dest)
            if digest != f.sha256:
                dest.unlink(missing_ok=True)
                raise EngineError("BAD_FILE", f"sai sha256 cho {f.path}")
        else:
            ctx.log(f"sha256 {f.path} = {sha256_of(dest)} (chưa có trong manifest)")
    ctx.log("Đã tải xong")
