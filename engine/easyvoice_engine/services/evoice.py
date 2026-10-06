"""Định dạng chia sẻ giọng .evoice (spec 3.5): file zip gồm manifest.json + model RVC (safetensors) + audio mẫu tùy chọn.

Xuất: chỉ kèm audio mẫu (giọng thật) khi người xuất chủ động chọn; giọng nhập từ người khác không được kèm audio mẫu
và giữ nguyên tác giả / giấy phép gốc. Nhập: kiểm tra format_version, min_app_version, sha256 từng file, chỉ chấp nhận
danh sách file biết trước (không .pth, không đường dẫn lạ), giải nén vào thư mục tạm rồi mới tạo giọng."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from .. import __version__
from ..core.errors import EngineError
from .voices import VoiceProfile, VoiceStore, VoiceVariant

FORMAT_VERSION = 1
MIN_APP_VERSION = "0.1.0"
MAX_TOTAL_BYTES = 3_000_000_000  # chặn zip bomb: model RVC + index thường < 1 GB
ALLOWED = re.compile(r"^(manifest\.json|model\.safetensors|model\.index|rvc\.json|ref\.wav|ref\.txt|preview\.wav|"
                     r"variants/[0-9a-z]{1,16}/ref\.(wav|txt))$")
LICENSES = ("personal", "commercial", "noredist")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _ver(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3]) or (0,)


def export_voice(store: VoiceStore, voice_id: str, include_model: bool, include_ref: bool, license: str, author: str,
                 dest_dir: Path) -> Path:
    p = store.get(voice_id)
    d = store.dir(voice_id)
    if license not in LICENSES:
        raise EngineError("BAD_REQUEST", f"giấy phép không hợp lệ: {license}")
    if p.imported and p.license == "noredist":
        raise EngineError("BAD_REQUEST", "giọng này được nhập với giấy phép “Không được chia sẻ lại”")
    include_model = include_model and bool(p.rvc_model) and (d / (p.rvc_model or "")).exists()
    include_ref = include_ref and bool(p.ref_audio) and not p.imported  # spec 3.5
    if not include_model and not include_ref:
        raise EngineError("BAD_REQUEST", "chọn ít nhất model RVC hoặc audio mẫu để xuất")
    if p.imported:  # giữ tác giả / giấy phép gốc của người tạo giọng
        author = p.author or author
        license = p.license if p.license != "unknown" else ("personal" if license == "commercial" else license)

    files: dict[str, Path] = {}
    if include_model:
        files["model.safetensors"] = d / p.rvc_model  # type: ignore[operator]
        files["rvc.json"] = d / "rvc.json"
        if p.rvc_index and (d / p.rvc_index).exists():
            files["model.index"] = d / p.rvc_index
    variants = []
    if include_ref:
        files["ref.wav"] = d / p.ref_audio  # type: ignore[operator]
        (d / "ref.txt").write_text(p.ref_text or "", encoding="utf-8")
        files["ref.txt"] = d / "ref.txt"
        for v in p.variants:
            ref = d / v.ref_audio
            if not ref.exists():
                continue
            txt = ref.parent / "ref.txt"
            txt.write_text(v.ref_text, encoding="utf-8")
            files[f"variants/{v.id}/ref.wav"], files[f"variants/{v.id}/ref.txt"] = ref, txt
            variants.append({"id": v.id, "name": v.name, "emotion": v.emotion})
    if (d / "preview.wav").exists():
        files["preview.wav"] = d / "preview.wav"
    elif include_ref:
        files["preview.wav"] = d / p.ref_audio  # type: ignore[operator]

    caps = (["tts"] if include_ref else []) + (["sts"] if include_model else [])
    manifest = {
        "format_version": FORMAT_VERSION, "id": str(uuid.uuid4()), "name": p.name, "language": p.language,
        "author": author.strip()[:80] or "unknown", "license": license,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "min_app_version": MIN_APP_VERSION,
        "sample_rate": p.rvc_sample_rate if include_model else None, "pitch_hint": p.pitch_shift, "capabilities": caps,
        "ref_text": p.ref_text if include_ref else None, "variants": variants,
        "tags": {"gender": p.gender, "country": p.country, "region": p.region},
        "files": [{"path": name, "sha256": _sha256(src), "size": src.stat().st_size} for name, src in files.items()],
    }
    dest_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^\w\-]+", "-", p.name, flags=re.UNICODE).strip("-").lower() or "voice"
    out = dest_dir / f"{slug}.evoice"
    n = 2
    while out.exists():
        out = dest_dir / f"{slug}-{n}.evoice"
        n += 1
    tmp = out.with_suffix(".evoice.tmp")
    with zipfile.ZipFile(tmp, "w") as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for name, src in files.items():
            # audio / safetensors nén không đáng kể: lưu thẳng cho nhanh
            z.write(src, name, compress_type=zipfile.ZIP_DEFLATED if name.endswith((".json", ".txt")) else zipfile.ZIP_STORED)
    tmp.replace(out)
    return out


class Inspection:
    def __init__(self, manifest: dict, checks: list[tuple[str, str, bool]], blocked: bool, staging: Path | None) -> None:
        self.manifest, self.checks, self.blocked, self.staging = manifest, checks, blocked, staging


def inspect_evoice(path: Path, staging: Path) -> Inspection:
    """Kiểm tra và giải nén vào staging. Không ném lỗi cho file hỏng/không an toàn mà trả blocked=True kèm lý do."""
    checks: list[tuple[str, str, bool]] = []

    def blocked(key: str, why: str, manifest: dict | None = None) -> Inspection:
        checks.append((key, why, True))
        shutil.rmtree(staging, ignore_errors=True)
        return Inspection(manifest or {}, checks, True, None)

    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        return blocked("format", "not a zip / damaged")
    with z:
        names = [i.filename for i in z.infolist() if not i.is_dir()]
        bad = [n for n in names if not ALLOWED.match(n)]
        if bad:
            return blocked("format", f"unexpected file: {bad[0]}")
        if sum(i.file_size for i in z.infolist()) > MAX_TOTAL_BYTES:
            return blocked("format", "too large")
        try:
            manifest = json.loads(z.read("manifest.json"))
        except (KeyError, ValueError):
            return blocked("format", "manifest.json missing")
        if manifest.get("format_version") != FORMAT_VERSION:
            return blocked("format", f"EVOICE v{manifest.get('format_version')} not supported", manifest)
        checks.append(("format", f"EVOICE v{FORMAT_VERSION}", False))
        need = str(manifest.get("min_app_version") or "0")
        if _ver(need) > _ver(__version__):
            return blocked("appVersion", f"≥ {need} · this app {__version__}", manifest)
        listed = {f["path"]: f for f in manifest.get("files", []) if isinstance(f, dict) and "path" in f}
        files = [n for n in names if n != "manifest.json"]
        if set(files) != set(listed):
            return blocked("checksums", "file list does not match manifest", manifest)
        staging.mkdir(parents=True, exist_ok=True)
        for n in files:
            dest = staging / n
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(n) as src, dest.open("wb") as out:
                shutil.copyfileobj(src, out)
            if _sha256(dest) != listed[n].get("sha256"):
                return blocked("checksums", f"sha256 mismatch: {n}", manifest)
        checks.append(("checksums", f"{len(files)}/{len(files)} match", False))
    if (staging / "model.safetensors").exists():
        try:
            from safetensors import safe_open

            with safe_open(str(staging / "model.safetensors"), "pt") as f:
                keys = list(f.keys())
            meta = json.loads((staging / "rvc.json").read_text(encoding="utf-8"))
            if not keys or not isinstance(meta.get("config"), list):
                raise ValueError("empty")
        except Exception:  # noqa: BLE001
            return blocked("model", "invalid safetensors / rvc.json", manifest)
        checks.append(("model", "safetensors · weights only", False))
    else:
        checks.append(("model", "—", False))
    checks.append(("appVersion", f"≥ {need} · OK", False))
    return Inspection(manifest, checks, False, staging)


def import_evoice(store: VoiceStore, staging: Path, manifest: dict, name: str) -> VoiceProfile:
    has_model = (staging / "model.safetensors").exists()
    has_ref = (staging / "ref.wav").exists() and (staging / "ref.txt").exists()
    if not has_model and not has_ref:
        raise EngineError("BAD_FILE", "file .evoice không có model hay audio mẫu")
    lang = manifest.get("language") if manifest.get("language") in ("vi", "en") else "unknown"
    lic = manifest.get("license") if manifest.get("license") in LICENSES else "unknown"
    tags = manifest.get("tags") or {}
    meta_sr = None
    if has_model:
        meta_sr = int(json.loads((staging / "rvc.json").read_text(encoding="utf-8")).get("sr") or manifest.get("sample_rate") or 40000)
    caps = (["tts"] if has_ref else []) + (["sts"] if has_model else [])
    p = store._new(name or manifest.get("name") or "Giọng nhập", lang, capabilities=caps, imported=True,  # noqa: SLF001
                   author=str(manifest.get("author") or "unknown")[:80], license=lic, consent_confirmed=True,
                   rvc_model="model.safetensors" if has_model else None,
                   rvc_index="model.index" if (staging / "model.index").exists() else None, rvc_sample_rate=meta_sr,
                   pitch_shift=float(manifest.get("pitch_hint") or 0.0),
                   ref_audio="ref.wav" if has_ref else None,
                   ref_text=(staging / "ref.txt").read_text(encoding="utf-8").strip() if has_ref else None,
                   gender=tags.get("gender") if tags.get("gender") in ("male", "female", "other") else None,
                   country=tags.get("country") if isinstance(tags.get("country"), str) and len(tags.get("country")) == 2 else None,
                   region=str(tags.get("region"))[:40] if tags.get("region") else None)
    d = store.dir(p.id)
    shutil.copytree(staging, d)
    variants = []
    for v in manifest.get("variants") or []:
        vid = str(v.get("id", ""))
        ref, txt = d / "variants" / vid / "ref.wav", d / "variants" / vid / "ref.txt"
        if has_ref and re.fullmatch(r"[0-9a-z]{1,16}", vid) and ref.exists() and txt.exists():
            variants.append(VoiceVariant(id=vid, name=str(v.get("name") or vid)[:40], emotion=v.get("emotion"),
                                         ref_audio=f"variants/{vid}/ref.wav", ref_text=txt.read_text(encoding="utf-8").strip(),
                                         created_at=p.created_at))
    p.variants = variants
    store._write(p)  # noqa: SLF001
    store.on_change()
    return p
