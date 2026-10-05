from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse, Response

from ..core.errors import EngineError
from ..core.job_queue import TtsSentence
from ..core.state import EngineState
from ..schemas import JobRef, RedoRequest, TtsRequest
from ..services import audio_io
from ..services.registry import ASR_KEY, CONTENTVEC_KEY, RMVPE_KEY, ensure_rvc_voice, pick_tts_model, tts_key
from ..services.tts.pipeline import TtsRender, VoiceRef, plan_parts, run_tts, text_language
from ..services.tts.ref_prep import prepare_ref
from .deps import get_state

router = APIRouter(tags=["tts"])


def _render(state: EngineState, job_id: str) -> TtsRender:
    render = state.extras.get(f"tts:{job_id}")
    if render is None:
        raise EngineError("NOT_FOUND", f"tts job {job_id}")
    return render


def _runner(state: EngineState, render: TtsRender):
    return lambda ctx: run_tts(ctx, render, lambda: state.models.get(tts_key(state, render.model_id)), state.register_file)


@router.post("/tts", response_model=JobRef)
def start_tts(req: TtsRequest, state: EngineState = Depends(get_state)) -> JobRef:
    default = (req.profile_id, req.variant_id or None)
    parts = [(p.text, (p.profile_id, p.variant_id or None)) for p in req.parts] or [(req.text, default)]
    planned = plan_parts(parts)
    if not planned:
        raise EngineError("BAD_REQUEST", "văn bản trống")
    # Kiểm tra mọi giọng/biến thể được dùng TRƯỚC khi nhận job (lỗi báo ngay cho UI, không phải giữa chừng).
    refs: dict = {}
    for key in {default, *(k for _, k in planned)}:
        p, ref, text, cache = state.voices.tts_ref(*key)
        refs[key] = VoiceRef(ref, text, cache, p.language)
    profile = state.voices.get(req.profile_id)
    # Chuẩn hóa + chọn model theo ngôn ngữ của VĂN BẢN (giọng mẫu tiếng Anh vẫn đọc được văn bản tiếng Việt).
    lang = text_language(req.text or " ".join(t for t, _ in parts), profile.language)
    # Tạo render TRƯỚC khi submit: worker có thể chạy job ngay lập tức.
    render = TtsRender(state.paths.jobs, lang, refs, default, req.speed, req.seed, max(0, min(2000, req.pause_ms)),
                       [tuple(x) for x in req.user_dict])
    render.model_id = pick_tts_model(state, lang)
    if req.mode == "chain":
        if not profile.rvc_model:
            raise EngineError("NO_STS_VOICE", "chế độ Qua RVC cần giọng đã huấn luyện")
        render.chain = _chain_converter(state)
        render.out_sr = profile.rvc_sample_rate or 40000

    def run(ctx):
        render.out_dir = state.job_dir(ctx.job)
        ctx.log(f"Model TTS: {render.model_id} · văn bản {lang} · {len(refs)} giọng")
        for r in refs.values():
            try:
                r.ref_audio, r.ref_text = prepare_ref(r.cache_dir, r.ref_audio, r.ref_text, r.language,
                                                      lambda path, lang: state.models.get(ASR_KEY).words(path, lang))
            except EngineError as exc:  # thiếu Whisper: để F5-TTS tự cắt (chất lượng kém hơn với ref dài)
                ctx.log(f"Không chuẩn bị được ref: {exc}")
        _runner(state, render)(ctx)

    sentences = [TtsSentence(index=i, text=s, profile_id=None if k == default else k[0],
                             variant_id=None if k == default else k[1]) for i, (s, k) in enumerate(planned)]
    job = state.queue.submit("tts", profile.name, run, profile_id=profile.id, sentences=sentences)
    state.extras[f"tts:{job.id}"] = render
    return JobRef(job_id=job.id)


def _chain_converter(state: EngineState):
    """Chế độ "Qua RVC" (spec mục 2): F5-TTS đọc bằng giọng mẫu, rồi đưa qua RVC của giọng để giống và ổn định hơn.
    Giọng không có RVC (khi đọc nhiều giọng) giữ nguyên bản F5-TTS."""
    from ..services.rvc.infer import SR_16K, ConvertParams, Index, convert_long

    def convert(wav, sr, profile_id):
        p = state.voices.get(profile_id)
        if not p.rvc_model:
            return wav, sr
        model = ensure_rvc_voice(state, profile_id)
        d = state.voices.dir(profile_id)
        index = Index(d / p.rvc_index) if p.rvc_index and (d / p.rvc_index).exists() else None
        y = convert_long(model, state.models.get(CONTENTVEC_KEY), state.models.get(RMVPE_KEY), index,
                         audio_io.resample(wav, sr, SR_16K), ConvertParams(pitch_shift=p.pitch_shift))
        return y, model.sr

    return convert


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
