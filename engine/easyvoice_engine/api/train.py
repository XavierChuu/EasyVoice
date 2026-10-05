"""Huấn luyện giọng "Chất lượng cao" (Phase 3)."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile

from ..core.errors import EngineError
from ..core.job_queue import Job
from ..core.state import EngineState
from ..schemas import Profile
from ..services.registry import ASR_KEY, CONTENTVEC_KEY, DEMUCS_ID, PRETRAINED_ID, RMVPE_KEY, SEP_KEY, ensure_train_nets
from ..services.rvc.train.config import PRESET_EPOCHS
from ..services.rvc.train.pipeline import TrainSpec, progress_of, run_training, train_dir
from ..services.voices import clean_tags
from .deps import get_state, save_upload

router = APIRouter(tags=["train"])
MEDIA_EXT = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".mp4", ".mkv", ".mov", ".webm", ".avi"}


def _runner(state: EngineState):
    return lambda ctx: run_training(ctx, state, SEP_KEY, ASR_KEY, CONTENTVEC_KEY, RMVPE_KEY)


def check_training_ready(state: EngineState, separate: bool) -> None:
    if state.device() == "cpu" and os.environ.get("EASYVOICE_ALLOW_CPU_TRAIN") != "1":
        raise EngineError("GPU_REQUIRED")  # spec mục 1: train RVC không hỗ trợ CPU
    for mid in ("contentvec", "rmvpe", PRETRAINED_ID, *([DEMUCS_ID] if separate else [])):
        state.catalog.require(mid)


@router.post("/train", response_model=Profile)
def start_training(
    name: str = Form(...), language: Literal["vi", "en"] = Form("vi"), preset: Literal["fast", "balanced", "thorough"] = Form("balanced"),
    separate: bool = Form(True), consent: bool = Form(...),
    paths: str = Form("[]", description="JSON: đường dẫn file trên máy (app desktop gửi đường dẫn thay vì upload)"),
    epochs: int | None = Form(None, description="Ghi đè số epoch của preset (nâng cao)"),
    gender: str | None = Form(None), country: str | None = Form(None), region: str | None = Form(None),
    files: list[UploadFile] = File(default=[]), state: EngineState = Depends(get_state),
) -> Profile:
    check_training_ready(state, separate)
    local = [Path(p) for p in json.loads(paths or "[]")]
    for p in local:
        if not p.is_file() or p.suffix.lower() not in MEDIA_EXT:
            raise EngineError("BAD_FILE", str(p))
    if not local and not files:
        raise EngineError("BAD_REQUEST", "cần ít nhất một file audio/video")
    profile = state.voices.create_training(name, language, consent, clean_tags(gender, country, region))
    root = train_dir(state, profile.id)
    sources: list[str] = []
    for i, p in enumerate(local):
        dest = root / "sources" / f"{i:02d}{p.suffix.lower()}"
        shutil.copy2(p, dest)
        sources.append(dest.name)
    for f in files:
        up = save_upload(state, f)
        dest = root / "sources" / f"{len(sources):02d}{up.suffix.lower()}"
        shutil.move(up, dest)
        sources.append(dest.name)
    spec = TrainSpec(voice_id=profile.id, preset=preset, separate=separate,
                     epochs=max(1, epochs or PRESET_EPOCHS[preset]), sources=sources)
    spec.save(root / "state.json")
    ensure_train_nets(state, profile.id)
    job = state.queue.submit("train", profile.name, _runner(state), profile_id=profile.id, total_epochs=spec.epochs)
    job.log.append(f"{len(sources)} file · preset {preset} · {spec.epochs} epoch"
                   + (" · tách nhạc nền + khử nhiễu" if separate else ""))
    state.voices.set_train_job(profile.id, job.id)
    return state.voices.to_api(state.voices.get(profile.id))


def resume_training(state: EngineState, job: Job) -> Job:
    spec = TrainSpec.load(train_dir(state, job.profile_id or "") / "state.json")
    check_training_ready(state, spec.separate and "preprocess" not in spec.done)
    ensure_train_nets(state, job.profile_id or "")
    job.log.append(f"Tiếp tục · đã xong: {', '.join(spec.done) or 'chưa có bước nào'} · epoch {spec.epochs_done}/{spec.epochs}")
    return state.queue.resume(job.id)


def recover_interrupted(state: EngineState) -> None:
    """Tắt app giữa lúc train: khôi phục job ở trạng thái "Tạm dừng" để người dùng bấm Tiếp tục (checkpoint trên đĩa)."""
    for p in state.voices.list():
        state_file = train_dir(state, p.id) / "state.json"
        if not p.train_job_id or not state_file.exists() or p.train_job_id in state.queue.jobs:
            continue
        spec = TrainSpec.load(state_file)
        job = Job(id=p.train_job_id, kind="train", status="paused", label=p.name, profile_id=p.id,
                  progress=progress_of(spec), total_epochs=spec.epochs, epoch=spec.epochs_done or None,
                  log=[f"Bị gián đoạn khi tắt app · đã xong: {', '.join(spec.done) or 'chưa có bước nào'} · "
                       f"epoch {spec.epochs_done}/{spec.epochs} — bấm Tiếp tục để chạy tiếp"])
        state.queue.restore(job, _runner(state))
