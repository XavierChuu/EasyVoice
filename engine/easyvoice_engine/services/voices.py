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
    sample_rate: int | None


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

    @staticmethod
    def to_api(p: VoiceProfile) -> Profile:
        return Profile(id=p.id, name=p.name, language=p.language, created_at=p.created_at, capabilities=p.capabilities,
                       train_job_id=p.train_job_id, imported=p.imported, author=p.author, license=p.license,
                       has_ref=bool(p.ref_audio), sample_rate=p.rvc_sample_rate)

    def _new(self, name: str, language: Lang, **fields) -> VoiceProfile:
        name = name.strip()
        if not name:
            raise EngineError("BAD_REQUEST", "tên giọng trống")
        return VoiceProfile(id=uuid.uuid4().hex[:12], name=name[:80], language=language,
                            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), **fields)

    def create_quick(self, name: str, language: Lang, transcript: str, upload: Path, consent: bool) -> VoiceProfile:
        if not consent:
            raise EngineError("BAD_REQUEST", "cần xác nhận quyền sử dụng giọng")
        if not transcript.strip():
            raise EngineError("BAD_REQUEST", "thiếu lời thoại")
        audio, sr = audio_io.load(upload, REF_SR)
        if len(audio) < sr:
            raise EngineError("BAD_FILE", "audio quá ngắn")
        clean, _ = clean_reference(audio, sr)
        p = self._new(name, language, capabilities=["tts"], ref_audio="ref.wav", ref_text=transcript.strip(),
                      consent_confirmed=True)
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

    def rename(self, voice_id: str, name: str) -> VoiceProfile:
        with self._lock:
            p = self.get(voice_id)
            if not name.strip():
                raise EngineError("BAD_REQUEST", "tên giọng trống")
            p.name = name.strip()[:80]
            self._write(p)
        self.on_change()
        return p

    def delete(self, voice_id: str) -> None:
        self.get(voice_id)
        shutil.rmtree(self.dir(voice_id), ignore_errors=True)
        self.on_change()

    def preview_path(self, voice_id: str) -> Path:
        p = self.get(voice_id)
        d = self.dir(voice_id)
        for name in ("preview.wav", p.ref_audio or ""):
            if name and (d / name).exists():
                return d / name
        raise EngineError("NOT_FOUND", "giọng này chưa có đoạn nghe thử")
