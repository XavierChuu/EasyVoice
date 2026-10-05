"""Dự án Edit Audio: mỗi dự án là một thư mục projects/<id>/.

- project.json: timeline (track, clip, người nói, tên) — do app sở hữu, app lưu lại sau mỗi thao tác.
- assets/<aid>.wav + assets/<aid>.json: audio nguồn và dữ liệu engine tính ra (lời thoại theo từ, lượt nói).
  Asset không bao giờ bị sửa: lọc / đổi giọng / sửa lời luôn tạo asset mới, timeline trỏ sang asset mới
  → hoàn tác được, file gốc nguyên vẹn.

Audio asset luôn là WAV mono 48 kHz (quy ước engine: float32 mono, resample chỉ trong audio_io)."""

from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Literal

import numpy as np

from ...core.errors import EngineError
from ...core.job_queue import ApiModel
from .. import audio_io

PROJECT_SR = 48000
AssetSource = Literal["import", "record", "job", "separate", "filter", "convert", "retext", "speak", "duck"]


class EditWord(ApiModel):
    start: float  # giây, tính trong asset
    end: float
    text: str


class SpeakerTurn(ApiModel):
    start: float
    end: float
    speaker: int


class EditAsset(ApiModel):
    id: str
    name: str
    duration_sec: float
    sample_rate: int = PROJECT_SR
    source: AssetSource = "import"
    language: str | None = None
    words: list[EditWord] | None = None  # None = chưa chép lời
    turns: list[SpeakerTurn] | None = None  # None = chưa nhận diện người nói
    created_at: float = 0.0


class EditClip(ApiModel):
    id: str
    track_id: str
    asset_id: str
    start: float  # vị trí trên timeline (giây)
    offset: float  # điểm bắt đầu trong asset (giây)
    duration: float
    gain_db: float = 0.0
    fade_in: float = 0.0
    fade_out: float = 0.0
    label: str | None = None
    speaker: int | None = None  # gán màu người nói khi cắt theo chỗ đổi giọng


class EditTrack(ApiModel):
    id: str
    name: str
    color: str = "#F2F2F2"
    kind: Literal["audio", "voice", "music", "speaker"] = "audio"
    gain_db: float = 0.0
    mute: bool = False
    solo: bool = False


class EditSpeaker(ApiModel):
    id: int
    name: str
    color: str


class EditTimeline(ApiModel):
    name: str
    tracks: list[EditTrack] = []
    clips: list[EditClip] = []
    speakers: list[EditSpeaker] = []
    # Xóa / chèn làm dịch phần phía sau: trên mọi track (giữ đồng bộ), chỉ track đang sửa, hoặc không dịch.
    ripple: Literal["all", "track", "off"] = "all"


class EditProject(EditTimeline):
    id: str
    sample_rate: int = PROJECT_SR
    created_at: float
    updated_at: float
    assets: list[EditAsset] = []


class EditProjectSummary(ApiModel):
    id: str
    name: str
    updated_at: float
    duration_sec: float
    tracks: int


def timeline_end(t: EditTimeline) -> float:
    return max((c.start + c.duration for c in t.clips), default=0.0)


class EditStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    # ----- đường dẫn -----
    def dir(self, pid: str) -> Path:
        d = self.root / pid
        if not pid.isalnum() or not (d / "project.json").exists():
            raise EngineError("NOT_FOUND", f"dự án {pid}")
        return d

    def asset_path(self, pid: str, aid: str) -> Path:
        p = self.dir(pid) / "assets" / f"{aid}.wav"
        if not aid.isalnum() or not p.exists():
            raise EngineError("NOT_FOUND", f"asset {aid}")
        return p

    # ----- dự án -----
    def create(self, name: str) -> EditProject:
        pid = uuid.uuid4().hex[:12]
        now = time.time()
        d = self.root / pid
        (d / "assets").mkdir(parents=True)
        timeline = EditTimeline(name=name.strip()[:80] or "Dự án mới")
        self._write_timeline(d, timeline, now, now)
        return self.get(pid)

    def _write_timeline(self, d: Path, t: EditTimeline, created: float, updated: float) -> None:
        data = t.model_dump(by_alias=True) | {"createdAt": created, "updatedAt": updated, "sampleRate": PROJECT_SR}
        tmp = d / "project.json.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(d / "project.json")

    def _read(self, pid: str) -> dict:
        return json.loads((self.dir(pid) / "project.json").read_text(encoding="utf-8"))

    def timeline(self, pid: str) -> EditTimeline:
        return EditTimeline.model_validate(self._read(pid))

    def get(self, pid: str) -> EditProject:
        with self._lock:
            data = self._read(pid)
            return EditProject.model_validate(data | {"id": pid, "assets": [a.model_dump() for a in self.assets(pid)]})

    def save(self, pid: str, t: EditTimeline) -> EditProject:
        with self._lock:
            data = self._read(pid)
            known = {a.id for a in self.assets(pid)}
            track_ids = {tr.id for tr in t.tracks}
            for c in t.clips:
                if c.asset_id not in known:
                    raise EngineError("BAD_REQUEST", f"clip {c.id}: asset {c.asset_id} không tồn tại")
                if c.track_id not in track_ids:
                    raise EngineError("BAD_REQUEST", f"clip {c.id}: track {c.track_id} không tồn tại")
                if c.duration <= 0 or c.offset < 0 or c.start < 0:
                    raise EngineError("BAD_REQUEST", f"clip {c.id}: thời gian không hợp lệ")
            self._write_timeline(self.dir(pid), t, data.get("createdAt", time.time()), time.time())
            return self.get(pid)

    def list(self) -> list[EditProjectSummary]:
        out = []
        for d in self.root.iterdir():
            f = d / "project.json"
            if not f.exists():
                continue
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                t = EditTimeline.model_validate(data)
            except (ValueError, OSError):
                continue
            out.append(EditProjectSummary(id=d.name, name=t.name, updated_at=data.get("updatedAt", 0.0),
                                          duration_sec=timeline_end(t), tracks=len(t.tracks)))
        return sorted(out, key=lambda p: -p.updated_at)

    def delete(self, pid: str) -> None:
        with self._lock:
            shutil.rmtree(self.dir(pid))

    def gc(self, pid: str) -> int:
        """Xóa asset không clip nào dùng (bản nghe thử A/B chưa áp dụng...). Chỉ gọi khi mở dự án (chưa có lịch sử hoàn tác)."""
        with self._lock:
            used = {c.asset_id for c in self.timeline(pid).clips}
            n = 0
            for a in self.assets(pid):
                if a.id not in used:
                    for ext in ("wav", "json"):
                        (self.dir(pid) / "assets" / f"{a.id}.{ext}").unlink(missing_ok=True)
                    n += 1
            return n

    # ----- asset -----
    def assets(self, pid: str) -> list[EditAsset]:
        d = self.dir(pid) / "assets"
        out = []
        for f in d.glob("*.json"):
            try:
                out.append(EditAsset.model_validate_json(f.read_text(encoding="utf-8")))
            except ValueError:
                continue
        return sorted(out, key=lambda a: a.created_at)

    def asset(self, pid: str, aid: str) -> EditAsset:
        f = self.dir(pid) / "assets" / f"{aid}.json"
        if not aid.isalnum() or not f.exists():
            raise EngineError("NOT_FOUND", f"asset {aid}")
        return EditAsset.model_validate_json(f.read_text(encoding="utf-8"))

    def update_asset(self, pid: str, asset: EditAsset) -> EditAsset:
        with self._lock:
            f = self.dir(pid) / "assets" / f"{asset.id}.json"
            tmp = f.with_suffix(".tmp")
            tmp.write_text(asset.model_dump_json(by_alias=True), encoding="utf-8")
            tmp.replace(f)
            return asset

    def add_asset(self, pid: str, audio: np.ndarray, sr: int, name: str, source: AssetSource,
                  words: list[EditWord] | None = None, language: str | None = None) -> EditAsset:
        y = audio_io.resample(np.asarray(audio, dtype=np.float32), sr, PROJECT_SR)
        if y.size == 0:
            raise EngineError("BAD_FILE", f"{name}: audio trống")
        aid = uuid.uuid4().hex[:12]
        audio_io.save(self.dir(pid) / "assets" / f"{aid}.wav", y, PROJECT_SR)
        asset = EditAsset(id=aid, name=name[:80], duration_sec=len(y) / PROJECT_SR, source=source, words=words,
                          language=language, created_at=time.time())
        return self.update_asset(pid, asset)

    def import_file(self, pid: str, path: Path, name: str, source: AssetSource = "import") -> EditAsset:
        audio, sr = audio_io.load(path)
        return self.add_asset(pid, audio, sr, name, source)

    def load(self, pid: str, aid: str) -> np.ndarray:
        """Audio của asset ở PROJECT_SR."""
        audio, _ = audio_io.load(self.asset_path(pid, aid), PROJECT_SR)
        return audio

    def segment(self, pid: str, aid: str, offset: float, duration: float, pad: float = 0.0) -> tuple[np.ndarray, int, int]:
        """Đoạn [offset, offset+duration] của asset, kèm tối đa `pad` giây ngữ cảnh mỗi bên.
        Trả (audio, số mẫu ngữ cảnh phía trước, số mẫu của đoạn) để cắt lại sau khi xử lý."""
        audio = self.load(pid, aid)
        a = max(0, int(round(offset * PROJECT_SR)))
        b = min(len(audio), int(round((offset + duration) * PROJECT_SR)))
        if b <= a:
            raise EngineError("BAD_REQUEST", "đoạn chọn trống")
        pa = max(0, a - int(pad * PROJECT_SR))
        pb = min(len(audio), b + int(pad * PROJECT_SR))
        return audio[pa:pb], a - pa, b - a
