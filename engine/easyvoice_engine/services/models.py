"""Danh sách model (models.manifest.json: url, sha256, size, license) và downloader có kiểm sha256 + tải tiếp."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from pydantic import BaseModel, field_validator

from ..core.errors import EngineError
from ..core.job_queue import ApiModel, JobContext

CHUNK = 1 << 20
log = logging.getLogger(__name__)


class ManifestFile(BaseModel):
    path: str
    url: str
    sha256: str | None = None
    size_mb: float | None = None

    @field_validator("sha256")
    @classmethod
    def _valid_sha(cls, v: str | None) -> str | None:
        # sha256 viết sai (thiếu/thừa ký tự) thì không bao giờ khớp → mọi lần tải đều bị xóa. Coi như chưa có hash.
        if v is not None and not re.fullmatch(r"[0-9a-f]{64}", v.lower()):
            log.warning("sha256 không hợp lệ trong manifest, bỏ qua kiểm tra: %s", v)
            return None
        return v.lower() if v else v


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
    try:
        resp_cm = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as exc:
        if exc.code == 416 and have:  # file .part đã đủ (lần trước rớt mạng đúng lúc vừa tải xong)
            part.replace(dest)
            return
        raise
    with resp_cm as resp:
        if have and resp.status != 206:  # máy chủ không hỗ trợ tải tiếp → tải lại từ đầu
            have = 0
        length = resp.headers.get("Content-Length")
        expected = have + int(length) if length and length.isdigit() else None
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
    # Kết nối bị cắt giữa chừng có thể trông như "đã tải xong": kiểm tra đủ dung lượng máy chủ báo, thiếu thì giữ .part
    # để lần sau tải tiếp, không bao giờ đổi tên một file thiếu thành file model.
    size = part.stat().st_size
    if expected is not None and size < expected:
        raise ConnectionError(f"tải chưa đủ: {size / 1e6:.0f}/{expected / 1e6:.0f} MB")
    part.replace(dest)


RETRY_ATTEMPTS = 8


def _retryable(exc: Exception) -> bool:
    """Lỗi mạng tạm thời (rớt mạng, treo kết nối, máy chủ quá tải) → tự tải tiếp; lỗi 4xx thì không."""
    import http.client

    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in (408, 429) or exc.code >= 500
    return isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException, OSError))


def download_with_retry(url: str, dest: Path, on_file_bytes, check, log, attempts: int = RETRY_ATTEMPTS,
                        sleep=time.sleep) -> None:
    """Tải một file, tự thử lại khi rớt mạng (tải tiếp từ .part). on_file_bytes(n) nhận số byte ĐÃ CÓ của file
    (tuyệt đối) để tiến độ không bị cộng trùng khi tải tiếp."""
    for attempt in range(1, attempts + 1):
        got = 0

        def count(n: int) -> None:
            nonlocal got
            got += n
            on_file_bytes(got)

        try:
            download_file(url, dest, count, check)
            return
        except Exception as exc:  # noqa: BLE001
            if type(exc).__name__ == "Cancelled" or attempt == attempts or not _retryable(exc):
                raise
            wait = min(30, 2 ** attempt)
            part = dest.with_name(dest.name + ".part")
            have = part.stat().st_size / 1e6 if part.exists() else 0
            log(f"Mất kết nối ({exc}); thử lại sau {wait}s, lần {attempt + 1}/{attempts} — tải tiếp từ {have:.0f} MB")
            for _ in range(wait * 2):
                if check:
                    check()
                sleep(0.5)


def _download_error(m: ManifestModel, exc: Exception) -> str:
    """Lý do tải lỗi, viết cho người dùng đọc được."""
    import urllib.error

    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (401, 403):
            return (f"{m.name}: máy chủ từ chối truy cập (HTTP {exc.code}). Model này có thể yêu cầu đăng nhập Hugging Face "
                    f"và chấp nhận điều khoản trên trang model; đặt biến môi trường HF_TOKEN rồi thử lại.")
        if exc.code == 404:
            return f"{m.name}: không tìm thấy file trên máy chủ (HTTP 404)."
        return f"{m.name}: lỗi máy chủ HTTP {exc.code}."
    if isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError, OSError)) and not isinstance(exc, EngineError):
        reason = getattr(exc, "reason", exc)
        return f"{m.name}: không kết nối được ({reason}). Kiểm tra mạng / tường lửa / proxy rồi bấm Thử lại — phần đã tải được giữ lại."
    return f"{m.name}: {exc}"


def run_download(ctx: JobContext, catalog: ModelCatalog, ids: list[str]) -> None:
    """Tải từng model; model lỗi không chặn các model còn lại. Tiến độ: job.progress + job.stage = file đang tải,
    job.result = số MB đã tải / tổng để UI hiện rõ (file vài GB thì % tăng rất chậm)."""
    import time

    models = [catalog.get(mid) for mid in ids]
    files = [(m, f) for m in models for f in m.files if not (catalog.models_dir / f.path).exists()]
    total = sum((f.size_mb or 1) * 1e6 for _, f in files) or 1.0
    done = 0.0  # byte của các file đã xong
    file_bytes = 0.0  # byte đã có của file đang tải
    last = 0.0
    speed = 0.0
    mark = (time.monotonic(), 0.0)
    current = ""

    def report(force: bool = False) -> None:
        nonlocal last, speed, mark
        now = time.monotonic()
        if not force and now - last < 0.4:
            return
        last = now
        cur = done + file_bytes
        if now - mark[0] >= 2.0:  # tốc độ trung bình 2 s gần nhất
            speed = max(0.0, (cur - mark[1]) / (now - mark[0]))
            mark = (now, cur)
        ctx.job.result = {"doneMb": round(cur / 1e6, 1), "totalMb": round(total / 1e6, 1), "file": current,
                          "speedMbps": round(speed / 1e6, 2)}
        ctx.progress(min(0.999, cur / total), current)

    def on_file_bytes(n: int) -> None:
        nonlocal file_bytes
        file_bytes = n
        report()

    failed: list[str] = []
    for m in models:
        mfiles = [f for mm, f in files if mm.id == m.id]
        start_done = done
        try:
            for f in mfiles:
                dest = catalog.models_dir / f.path
                current = f.path
                file_bytes = 0.0
                ctx.log(f"Tải {m.name}: {f.path}")
                report(force=True)
                download_with_retry(f.url, dest, on_file_bytes, ctx.check_cancel, ctx.log)
                done += (f.size_mb or 1) * 1e6 if not dest.exists() else dest.stat().st_size
                file_bytes = 0.0
                if f.sha256:
                    digest = sha256_of(dest)
                    if digest != f.sha256:
                        dest.unlink(missing_ok=True)
                        raise EngineError("BAD_FILE", f"sai sha256 cho {f.path}: tải về {digest[:12]}…, manifest {f.sha256[:12]}… "
                                                      "(file có thể đã được cập nhật trên máy chủ hoặc tải bị lỗi)")
                else:
                    ctx.log(f"sha256 {f.path} = {sha256_of(dest)} (chưa có trong manifest)")
        except Exception as exc:  # noqa: BLE001 — hủy (Cancelled) không phải Exception thường nên vẫn dừng job
            if type(exc).__name__ == "Cancelled":
                raise
            msg = _download_error(m, exc)
            ctx.log(f"LỖI {msg}")
            failed.append(msg)
            done = start_done + sum((f.size_mb or 1) * 1e6 for f in mfiles)  # bỏ qua phần còn lại của model lỗi trong %
            file_bytes = 0.0
    current = ""
    report(force=True)
    if failed:
        raise EngineError("DOWNLOAD_FAILED", " | ".join(failed))
    ctx.log("Đã tải xong")
