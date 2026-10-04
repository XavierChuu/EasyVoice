from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse, Response

from ..core.errors import EngineError
from ..core.job_queue import TtsSentence
from ..core.state import EngineState
from ..schemas import JobRef, RedoRequest, TtsRequest
from ..services import audio_io
from ..services.registry import TTS_KEY
from ..services.tts.pipeline import TtsRender, plan_sentences, run_tts
from .deps import get_state

router = APIRouter(tags=["tts"])


def _render(state: EngineState, job_id: str) -> TtsRender:
    render = state.extras.get(f"tts:{job_id}")
    if render is None:
        raise EngineError("NOT_FOUND", f"tts job {job_id}")
    return render


def _runner(state: EngineState, render: TtsRender):
    return lambda ctx: run_tts(ctx, render, lambda: state.models.get(TTS_KEY), state.register_file)


@router.post("/tts", response_model=JobRef)
def start_tts(req: TtsRequest, state: EngineState = Depends(get_state)) -> JobRef:
    if req.mode == "chain":
        raise EngineError("NOT_IMPLEMENTED", "chế độ Qua RVC có ở Phase 3")
    profile = state.voices.get(req.profile_id)
    if "tts" not in profile.capabilities or not profile.ref_audio:
        raise EngineError("BAD_REQUEST", "giọng này chưa dùng được cho Đọc văn bản")
    sentences = plan_sentences(req.text)
    if not sentences:
        raise EngineError("BAD_REQUEST", "văn bản trống")
    d = state.voices.dir(profile.id)
    # Tạo render TRƯỚC khi submit: worker có thể chạy job ngay lập tức.
    render = TtsRender(state.paths.jobs, profile.language, d / profile.ref_audio, profile.ref_text or "",
                       req.speed, req.seed, max(0, min(2000, req.pause_ms)), [tuple(x) for x in req.user_dict])

    def run(ctx):
        render.out_dir = state.job_dir(ctx.job)
        _runner(state, render)(ctx)

    job = state.queue.submit("tts", profile.name, run, profile_id=profile.id,
                             sentences=[TtsSentence(index=i, text=s) for i, s in enumerate(sentences)])
    state.extras[f"tts:{job.id}"] = render
    return JobRef(job_id=job.id)


@router.post("/tts/{job_id}/redo", response_model=JobRef)
def redo(job_id: str, req: RedoRequest, state: EngineState = Depends(get_state)) -> JobRef:
    render = _render(state, job_id)
    job = state.queue.get(job_id)
    sentences = job.sentences or []
    if not 0 <= req.index < len(sentences) or sentences[req.index].status != "done":
        raise EngineError("BAD_REQUEST", "câu chưa render xong")
    sentences[req.index].status, sentences[req.index].progress = "redo", 0.0
    state.queue.requeue(job_id, _runner(state, render))
    return JobRef(job_id=job_id)


@router.get("/tts/{job_id}/audio", response_class=Response)
def tts_audio(job_id: str, index: int | None = None, state: EngineState = Depends(get_state)) -> Response:
    """Một câu (index) hoặc các câu đã xong ghép lại — nghe được khi phần sau còn đang render."""
    render = _render(state, job_id)
    job = state.queue.get(job_id)
    if index is not None:
        path = render.sentence_path(index)
        if not path.exists():
            raise EngineError("NOT_FOUND", "câu chưa render xong")
        return FileResponse(path, media_type="audio/wav")
    sentences = [s for s in job.sentences or [] if s.status == "done" and render.sentence_path(s.index).exists()]
    if not sentences:
        raise EngineError("NOT_FOUND", "chưa có câu nào xong")
    import io

    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, render.join(sentences), render.sr, format="WAV", subtype="PCM_16")
    return Response(buf.getvalue(), media_type="audio/wav")


@router.get("/tts/{job_id}/export", response_class=FileResponse)
def tts_export(job_id: str, format: Literal["wav", "mp3", "flac", "srt"] = "wav",
               state: EngineState = Depends(get_state)) -> FileResponse:
    render = _render(state, job_id)
    job = state.queue.get(job_id)
    if job.status != "done":
        raise EngineError("BAD_REQUEST", "chưa render xong")
    wav = render.out_dir / "output.wav"
    if format == "srt":
        return FileResponse(render.out_dir / "output.srt", filename="easyvoice.srt", media_type="application/x-subrip")
    if format == "wav":
        return FileResponse(wav, filename="easyvoice.wav", media_type="audio/wav")
    out = render.out_dir / f"output.{format}"
    if not out.exists() or out.stat().st_mtime < wav.stat().st_mtime:
        audio, sr = audio_io.load(wav)
        audio_io.save(out, audio, sr)
    return FileResponse(out, filename=f"easyvoice.{format}")
