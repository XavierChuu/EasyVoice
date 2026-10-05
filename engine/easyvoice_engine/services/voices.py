"""Voice Profile (spec mục 2): mỗi giọng là một thư mục voices/<id>/ chứa profile.json, ref.wav + ref.txt (TTS),
model.safetensors + model.index + rvc.json (STS)."""

from __future__ import annotations

import json
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import numpy as np

from ..core.errors import EngineError
from ..core.job_queue import ApiModel
from . import audio_io

REF_SR = 24000  # F5-TTS làm việc ở 24 kHz
Lang = Literal["vi", "en", "unknown"]
License = Literal["personal", "commercial", "noredist", "unknown"]
Gender = Literal["male", "female", "other"]


def clean_tags(gender: str | None, country: str | None, region: str | None) -> dict:
    """Thẻ phân loại giọng: giới tính, quốc gia (mã ISO 3166 hai chữ, vd. VN), vùng miền (khóa gợi ý hoặc tự gõ)."""
    if gender not in (None, "", "male", "female", "other"):
        raise EngineError("BAD_REQUEST", f"giới tính không hợp lệ: {gender}")
    c = (country or "").strip().upper() or None
    if c is not None and (len(c) != 2 or not c.isalpha()):
        raise EngineError("BAD_REQUEST", f"mã quốc gia không hợp lệ: {country}")
    return {"gender": gender or None, "country": c, "region": (region or "").strip()[:40] or None}


class VoiceVariant(ApiModel):
    """Biến thể của cùng một người đọc (vui vẻ, giận dữ...): một đoạn ref riêng thể hiện cảm xúc đó.
    F5-TTS sao chép cả ngữ điệu/cảm xúc của đoạn ref, nên mỗi biến thể chỉ cần ref + lời thoại riêng."""

    id: str
    name: str
    emotion: str | None = None  # khóa cảm xúc gợi ý (happy, angry...) hoặc None nếu người dùng tự đặt tên
    created_at: str
    ref_audio: str  # đường dẫn tương đối trong thư mục giọng: variants/<id>/ref.wav
    ref_text: str


class VariantInfo(ApiModel):
    id: str
    name: str
    emotion: str | None
    created_at: str


class VoiceProfile(ApiModel):
    """Nội dung profile.json (spec: id, name, language, created_at, capabilities, ref_audio, ref_text, rvc_model,
    rvc_index, rvc_sample_rate, f0_method, pitch_shift, consent_confirmed, version)."""

    id: str
    name: str
    language: Lang = "vi"
    created_at: str
    capabilities: list[Literal["tts", "sts"]] = []
    ref_audio: str | None = None
    ref_text: str | None = None
    rvc_model: str | None = None
    rvc_index: str | None = None
    rvc_sample_rate: int | None = None
    f0_method: str = "rmvpe"
    pitch_shift: float = 0.0
    consent_confirmed: bool = False
    version: int = 1
    author: str | None = None
    license: License = "personal"
    imported: bool = False
    train_job_id: str | None = None
    variants: list[VoiceVariant] = []
    gender: Gender | None = None
    country: str | None = None
    region: str | None = None


class Profile(ApiModel):
    """Dạng gửi cho UI."""

    id: str
    name: str
    language: Lang
    created_at: str
    capabilities: list[Literal["tts", "sts"]]
    train_job_id: str | None
    imported: bool
    author: str | None
    license: License
    has_ref: bool
    has_preview: bool = False  # có đoạn nghe thử (ref.wav hoặc preview.wav sau khi train)
    sample_rate: int | None
    variants: list[VariantInfo] = []
    gender: Gender | None = None
    country: str | None = None
    region: str | None = None


class RefCheck(ApiModel):
    key: Literal["trim", "loudness", "music", "noise"]
    ok: bool


class RefAnalysis(ApiModel):
    duration_sec: float
    sample_rate: int
    channels: int
    checks: list[RefCheck]
    warnings: list[Literal["too_short", "too_long", "music", "noise", "clipping"]]


def _db(x: float) -> float:
    return 20 * np.log10(max(x, 1e-9))


def clean_reference(audio: np.ndarray, sr: int) -> tuple[np.ndarray, dict[str, float]]:
    """Cắt khoảng lặng đầu/cuối, chuẩn hóa âm lượng về −16 LUFS, giới hạn đỉnh."""
    import librosa
    import pyloudnorm

    trimmed, _ = librosa.effects.trim(audio, top_db=40)
    stats = {"trimmed_sec": (len(audio) - len(trimmed)) / sr}
    if len(trimmed) >= int(0.5 * sr):
        meter = pyloudnorm.Meter(sr)
        loud = meter.integrated_loudness(trimmed.astype(np.float64))
        if np.isfinite(loud):
            trimmed = pyloudnorm.normalize.loudness(trimmed.astype(np.float64), loud, -16.0).astype(np.float32)
            stats["loudness_lufs"] = float(loud)
    return audio_io.peak_normalize(trimmed.astype(np.float32)), stats


def analyze_reference(path: Path) -> RefAnalysis:
    duration, sr, channels = audio_io.info(path)
    audio, sr = audio_io.load(path)
    warnings: list = []
    if duration < 5:
        warnings.append("too_short")
    if duration > 12:
        warnings.append("too_long")
    if audio.size and np.mean(np.abs(audio) > 0.999) > 0.001:
        warnings.append("clipping")
    frame = max(1, sr // 50)
    n = len(audio) // frame
    noisy = False
    if n > 10:
        rms = np.sqrt(np.mean(audio[: n * frame].reshape(n, frame) ** 2, axis=1))
        noisy = _db(float(np.percentile(rms, 10))) > -45  # nền ồn cao khi không nói
        if noisy:
            warnings.append("noise")
    return RefAnalysis(duration_sec=duration, sample_rate=sr, channels=channels, warnings=warnings,
                       checks=[RefCheck(key="trim", ok=True), RefCheck(key="loudness", ok=True), RefCheck(key="noise", ok=not noisy)])


class VoiceStore:
    def __init__(self, root: Path, on_change=None) -> None:
        self.root = root
        self.on_change = on_change or (lambda: None)
        self._lock = threading.Lock()

    def dir(self, voice_id: str) -> Path:
        return self.root / voice_id

    def _read(self, d: Path) -> VoiceProfile | None:
        f = d / "profile.json"
        try:
            return VoiceProfile.model_validate_json(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _write(self, p: VoiceProfile) -> None:
        d = self.dir(p.id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "profile.json").write_text(json.dumps(p.model_dump(), indent=2, ensure_ascii=False), encoding="utf-8")

    def get(self, voice_id: str) -> VoiceProfile:
        p = self._read(self.dir(voice_id)) if voice_id and "/" not in voice_id and "\\" not in voice_id else None
        if p is None:
            raise EngineError("NOT_FOUND", f"voice {voice_id}")
        return p

    def list(self) -> list[VoiceProfile]:
        items = [p for d in self.root.iterdir() if d.is_dir() and (p := self._read(d))] if self.root.exists() else []
        return sorted(items, key=lambda p: p.created_at, reverse=True)

    def to_api(self, p: VoiceProfile) -> Profile:
        d = self.dir(p.id)
        return Profile(id=p.id, name=p.name, language=p.language, created_at=p.created_at, capabilities=p.capabilities,
                       has_preview=bool(p.ref_audio) or (d / "preview.wav").exists(),
                       train_job_id=p.train_job_id, imported=p.imported, author=p.author, license=p.license,
                       has_ref=bool(p.ref_audio), sample_rate=p.rvc_sample_rate,
                       variants=[VariantInfo(id=v.id, name=v.name, emotion=v.emotion, created_at=v.created_at)
                                 for v in p.variants],
                       gender=p.gender, country=p.country, region=p.region)

    def _new(self, name: str, language: Lang, **fields) -> VoiceProfile:
        name = name.strip()
        if not name:
            raise EngineError("BAD_REQUEST", "tên giọng trống")
        return VoiceProfile(id=uuid.uuid4().hex[:12], name=name[:80], language=language,
                            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), **fields)

    def create_quick(self, name: str, language: Lang, transcript: str, upload: Path, consent: bool,
                     tags: dict | None = None) -> VoiceProfile:
        if not consent:
            raise EngineError("BAD_REQUEST", "cần xác nhận quyền sử dụng giọng")
        if not transcript.strip():
            raise EngineError("BAD_REQUEST", "thiếu lời thoại")
        audio, sr = audio_io.load(upload, REF_SR)
        if len(audio) < sr:
            raise EngineError("BAD_FILE", "audio quá ngắn")
        clean, _ = clean_reference(audio, sr)
        p = self._new(name, language, capabilities=["tts"], ref_audio="ref.wav", ref_text=transcript.strip(),
                      consent_confirmed=True, **(tags or {}))
        d = self.dir(p.id)
        d.mkdir(parents=True)
        audio_io.save(d / "ref.wav", clean, sr)
        (d / "ref.txt").write_text(p.ref_text or "", encoding="utf-8")
        self._write(p)
        self.on_change()
        return p

    def import_rvc(self, name: str, converted_dir: Path, index: Path | None, meta: dict) -> VoiceProfile:
        p = self._new(name, "unknown", capabilities=["sts"], rvc_model="model.safetensors",
                      rvc_index="model.index" if index else None, rvc_sample_rate=int(meta["sr"]),
                      imported=True, author="unknown", license="unknown", consent_confirmed=True)
        d = self.dir(p.id)
        d.mkdir(parents=True)
        shutil.copy2(converted_dir / "model.safetensors", d / "model.safetensors")
        shutil.copy2(converted_dir / "rvc.json", d / "rvc.json")
        if index:
            shutil.copy2(index, d / "model.index")
        self._write(p)
        self.on_change()
        return p

    # ---------- huấn luyện (Phase 3) ----------
    def create_training(self, name: str, language: Lang, consent: bool, tags: dict | None = None) -> VoiceProfile:
        """Giọng "Chất lượng cao": chưa có năng lực nào cho tới khi train xong (TTS có sau bước chọn ref)."""
        if not consent:
            raise EngineError("BAD_REQUEST", "cần xác nhận quyền sử dụng giọng")
        p = self._new(name, language, capabilities=[], consent_confirmed=True, **(tags or {}))
        (self.dir(p.id) / "train" / "sources").mkdir(parents=True)
        self._write(p)
        return p

    def set_train_job(self, voice_id: str, job_id: str | None) -> None:
        with self._lock:
            p = self.get(voice_id)
            p.train_job_id = job_id
            self._write(p)
        self.on_change()

    def set_tts_ref(self, voice_id: str, ref: str, text: str) -> None:
        with self._lock:
            p = self.get(voice_id)
            p.ref_audio, p.ref_text = ref, text
            if "tts" not in p.capabilities:
                p.capabilities = ["tts", *p.capabilities]
            (self.dir(voice_id) / "ref.txt").write_text(text, encoding="utf-8")
            self._write(p)
        self.on_change()

    def finish_training(self, voice_id: str, sample_rate: int) -> None:
        with self._lock:
            p = self.get(voice_id)
            p.rvc_model, p.rvc_index, p.rvc_sample_rate = "model.safetensors", "model.index", sample_rate
            if "sts" not in p.capabilities:
                p.capabilities = [*p.capabilities, "sts"]
            p.train_job_id = None
            self._write(p)
        self.on_change()

    def update(self, voice_id: str, name: str | None = None, tags: dict | None = None) -> VoiceProfile:
        """Đổi tên và/hoặc thẻ phân loại. tags chỉ chứa các khóa người dùng gửi (gửi null = xóa thẻ)."""
        with self._lock:
            p = self.get(voice_id)
            if name is not None:
                if not name.strip():
                    raise EngineError("BAD_REQUEST", "tên giọng trống")
                p.name = name.strip()[:80]
            for k, v in (tags or {}).items():
                setattr(p, k, v)
            self._write(p)
        self.on_change()
        return p

    def delete(self, voice_id: str) -> None:
        self.get(voice_id)
        shutil.rmtree(self.dir(voice_id), ignore_errors=True)
        self.on_change()

    # ---------- biến thể ----------
    def add_variant(self, voice_id: str, name: str, emotion: str | None, transcript: str, upload: Path) -> VoiceProfile:
        name = name.strip()
        if not name:
            raise EngineError("BAD_REQUEST", "tên biến thể trống")
        if not transcript.strip():
            raise EngineError("BAD_REQUEST", "thiếu lời thoại")
        audio, sr = audio_io.load(upload, REF_SR)
        if len(audio) < sr:
            raise EngineError("BAD_FILE", "audio quá ngắn")
        clean, _ = clean_reference(audio, sr)
        with self._lock:
            p = self.get(voice_id)
            if "tts" not in p.capabilities:
                raise EngineError("BAD_REQUEST", "biến thể chỉ dùng cho giọng Đọc văn bản (có đoạn ref)")
            if any(v.name.casefold() == name.casefold() for v in p.variants):
                raise EngineError("BAD_REQUEST", f"đã có biến thể “{name}”")
            vid = uuid.uuid4().hex[:8]
            rel = f"variants/{vid}"
            d = self.dir(voice_id) / rel
            d.mkdir(parents=True)
            audio_io.save(d / "ref.wav", clean, sr)
            (d / "ref.txt").write_text(transcript.strip(), encoding="utf-8")
            p.variants.append(VoiceVariant(id=vid, name=name[:40], emotion=emotion or None, ref_audio=f"{rel}/ref.wav",
                                           ref_text=transcript.strip(),
                                           created_at=datetime.now(timezone.utc).isoformat(timespec="seconds")))
            self._write(p)
        self.on_change()
        return p

    def delete_variant(self, voice_id: str, variant_id: str) -> VoiceProfile:
        with self._lock:
            p = self.get(voice_id)
            v = self.variant(p, variant_id)
            p.variants = [x for x in p.variants if x.id != v.id]
            self._write(p)
            shutil.rmtree(self.dir(voice_id) / "variants" / v.id, ignore_errors=True)
        self.on_change()
        return p

    @staticmethod
    def variant(p: VoiceProfile, variant_id: str) -> VoiceVariant:
        v = next((x for x in p.variants if x.id == variant_id), None)
        if v is None:
            raise EngineError("NOT_FOUND", f"biến thể {variant_id}")
        return v

    def tts_ref(self, voice_id: str, variant_id: str | None) -> tuple[VoiceProfile, Path, str, Path]:
        """(profile, ref.wav, lời thoại, thư mục cache ref đã cắt) của giọng chuẩn hoặc một biến thể."""
        p = self.get(voice_id)
        if "tts" not in p.capabilities or not p.ref_audio:
            raise EngineError("BAD_REQUEST", f"giọng “{p.name}” chưa dùng được cho Đọc văn bản")
        d = self.dir(voice_id)
        if not variant_id:
            return p, d / p.ref_audio, p.ref_text or "", d
        v = self.variant(p, variant_id)
        ref = d / v.ref_audio
        return p, ref, v.ref_text, ref.parent

    def preview_path(self, voice_id: str, variant_id: str | None = None) -> Path:
        if variant_id:
            p = self.get(voice_id)
            return self.dir(voice_id) / self.variant(p, variant_id).ref_audio

        p = self.get(voice_id)
        d = self.dir(voice_id)
        for name in ("preview.wav", p.ref_audio or ""):
            if name and (d / name).exists():
                return d / name
        raise EngineError("NOT_FOUND", "giọng này chưa có đoạn nghe thử")
