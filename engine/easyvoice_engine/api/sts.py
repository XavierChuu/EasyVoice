from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse

from ..core.errors import EngineError
from ..core.job_queue import JobContext
from ..core.state import EngineState
from ..schemas import JobRef
from ..services import audio_io
from ..services.registry import CONTENTVEC_KEY, DEMUCS_ID, RMVPE_KEY, SEP_KEY, ensure_rvc_voice
from .deps import get_state, save_upload

router = APIRouter(tags=["sts"])
log = logging.getLogger(__name__)


@router.post("/sts/offline", response_model=JobRef)
def start_offline(
    profile_id: str = Form(..., alias="profileId"), pitch: float = Form(0.0), index_rate: float = Form(0.5, alias="indexRate"),
    protect: float = Form(0.33),
    separate: bool = Form(False), file: UploadFile = File(...), state: EngineState = Depends(get_state),
) -> JobRef:
    profile = state.voices.get(profile_id)
    if not profile.rvc_model:
        raise EngineError("NO_STS_VOICE")
    if separate:
        state.catalog.require(DEMUCS_ID)  # báo thiếu model ngay, không phải giữa chừng
    src = save_upload(state, file)

    def run(ctx: JobContext) -> None:
        from ..services.rvc.infer import SR_16K, ConvertParams, Index, convert_long

        out_dir = state.job_dir(ctx.job)
        ctx.progress(0.02, "demux")
        _, in_sr, _ = audio_io.info(src)
        audio, _ = audio_io.load(src, in_sr)
        ctx.log(f"Input {len(audio) / in_sr:.1f}s @ {in_sr} Hz · {ctx.job.device}")
        accompaniment = None
        if separate:  # spec 3.3: tách vocal, đổi giọng, trộn lại với nhạc nền gốc
            ctx.progress(0.05, "separate")
            audio, accompaniment = state.models.get(SEP_KEY).separate(audio, in_sr)
            ctx.log("Đã tách nhạc nền (Demucs)")
        else:
            ctx.progress(0.05, "prep")
        audio16k = audio_io.resample(audio, in_sr, SR_16K)
        model = ensure_rvc_voice(state, profile.id)
        encoder = state.models.get(CONTENTVEC_KEY)
        f0x = state.models.get(RMVPE_KEY)
        d = state.voices.dir(profile.id)
        index = Index(d / profile.rvc_index) if profile.rvc_index and (d / profile.rvc_index).exists() else None
        params = ConvertParams(pitch_shift=pitch, index_rate=index_rate, protect=protect)
        ctx.progress(0.2, "convert")
        y = convert_long(model, encoder, f0x, index, audio16k, params,
                         on_progress=lambda p: ctx.progress(0.2 + 0.75 * p, "convert"))
        ctx.progress(0.96, "remix" if separate else "join")
        y = audio_io.resample(y, model.sr, in_sr)  # spec 3.3: cùng sample rate với input
        if accompaniment is not None:
            n = min(len(y), len(accompaniment))
            y = y[:n] + accompaniment[:n]
        y = audio_io.peak_normalize(y)
        out = audio_io.save(out_dir / "converted.wav", y, in_sr)
        ctx.job.files["source"] = state.register_file(src, file.filename or "source")
        ctx.job.files["output"] = state.register_file(out, f"{(file.filename or 'audio').rsplit('.', 1)[0]}-converted.wav")
        ctx.job.output_duration_sec = len(y) / in_sr
        ctx.log("Xong")

    job = state.queue.submit("sts", file.filename or "audio", run, profile_id=profile.id)
    return JobRef(job_id=job.id)


@router.get("/sts/{job_id}/audio", response_class=FileResponse)
def sts_audio(job_id: str, which: Literal["a", "b"] = "b", download: bool = False,
              state: EngineState = Depends(get_state)) -> FileResponse:
    job = state.queue.get(job_id)
    fid = job.files.get("source" if which == "a" else "output")
    if not fid or fid not in state.files:
        raise EngineError("NOT_FOUND", "chưa có audio")
    path, name = state.files[fid]
    return FileResponse(path, filename=name if download else None)


@router.post("/realtime/start")
def realtime_start() -> None:
    raise EngineError("NOT_IMPLEMENTED", "đổi giọng trực tiếp có ở Phase 4")


@router.post("/realtime/stop")
def realtime_stop() -> None:
    raise EngineError("NOT_IMPLEMENTED", "đổi giọng trực tiếp có ở Phase 4")
