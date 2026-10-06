"""API trang Edit Audio: dự án (timeline do app giữ), asset audio, và các thao tác chạy dạng job.

Thao tác cần GPU/model AI (chép lời, nhận diện người nói, tách nhạc, đổi giọng, sửa lời, đọc giọng khác) là job
"edit" xếp hàng GPU như TTS/STS. Lọc âm, tìm khoảng lặng, ducking, đo và xuất file là job "mix" chỉ dùng CPU
nên chạy ngay cả khi GPU đang bận (vd. đang train)."""

from __future__ import annotations

import json
from typing import Annotated, Literal, Union

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import Field

from ..core.errors import EngineError
from ..core.job_queue import ApiModel, JobContext
from ..core.state import EngineState
from ..schemas import JobRef
from ..services import audio_io
from ..services.edit import ops
from ..services.edit.dsp import FILTERS
from ..services.edit.store import EditAsset, EditClip, EditProject, EditProjectSummary, EditTimeline, EditTrack, EditWord
from ..services.registry import DEMUCS_ID
from .deps import get_state, save_upload

router = APIRouter(tags=["edit"])


class NewProject(ApiModel):
    name: str = "Dự án mới"


class FromJob(ApiModel):
    job_id: str


class FromFile(ApiModel):
    file_id: str
    name: str | None = None


class Segment(ApiModel):
    """Một đoạn của asset (giây, theo thời gian trong asset)."""

    asset_id: str
    offset: float
    duration: float


class TranscribeOp(ApiModel):
    op: Literal["transcribe"]
    asset_ids: list[str]
    language: Literal["vi", "en", "auto"] = "auto"


class DiarizeOp(ApiModel):
    op: Literal["diarize"]
    asset_ids: list[str]
    num_speakers: int | None = None  # None = tự đoán


class SeparateOp(ApiModel):
    op: Literal["separate"]
    asset_ids: list[str]


class FilterOp(ApiModel):
    op: Literal["filter"]
    segments: list[Segment]
    filter: Literal["denoise", "highpass", "eq_voice", "eq_warm", "eq_bright", "telephone", "compress", "normalize", "loudness"]
    amount: float | None = None


class ConvertOp(ApiModel):
    op: Literal["convert"]
    segments: list[Segment]
    profile_id: str
    pitch: float = 0.0


class RetextOp(ApiModel):
    op: Literal["retext"]
    asset_id: str
    offset: float
    duration: float
    text: str
    keep_duration: bool = False
    language: Literal["vi", "en", "auto"] = "auto"
    seed: int = 1234


class SpeakOp(ApiModel):
    op: Literal["speak"]
    profile_id: str
    variant_id: str | None = None
    text: str
    speed: float = 1.0
    seed: int = 1234


class SilencesOp(ApiModel):
    op: Literal["silences"]
    timeline: EditTimeline
    track_ids: list[str] | None = None
    threshold_db: float = -45.0
    min_sec: float = 0.8


class DuckOp(ApiModel):
    op: Literal["duck"]
    timeline: EditTimeline
    music_track_ids: list[str]
    voice_track_ids: list[str]
    amount_db: float = -12.0


class RenderOp(ApiModel):
    op: Literal["render"]
    timeline: EditTimeline
    format: Literal["wav", "mp3", "flac"] | None = None  # None = chỉ đo loudness, không xuất file
    target_lufs: float | None = None
    srt: bool = False


EditOp = Annotated[Union[TranscribeOp, DiarizeOp, SeparateOp, FilterOp, ConvertOp, RetextOp, SpeakOp, SilencesOp, DuckOp,
                         RenderOp], Field(discriminator="op")]
LIGHT = {"filter", "silences", "duck", "render"}
LABELS = {"transcribe": "Chép lời", "diarize": "Nhận diện người nói", "separate": "Tách nhạc nền", "filter": "Lọc âm",
          "convert": "Đổi giọng", "retext": "Sửa lời", "speak": "Đọc văn bản", "silences": "Tìm khoảng lặng",
          "duck": "Hạ nhạc nền", "render": "Xuất file"}


@router.get("/edit/projects", response_model=list[EditProjectSummary])
def list_projects(state: EngineState = Depends(get_state)) -> list[EditProjectSummary]:
    return state.edit.list()


@router.post("/edit/projects", response_model=EditProject)
def create_project(req: NewProject, state: EngineState = Depends(get_state)) -> EditProject:
    return state.edit.create(req.name)


@router.get("/edit/projects/{pid}", response_model=EditProject)
def get_project(pid: str, gc: bool = False, state: EngineState = Depends(get_state)) -> EditProject:
    if gc:
        state.edit.gc(pid)
    return state.edit.get(pid)


@router.put("/edit/projects/{pid}", response_model=EditProject)
def save_project(pid: str, timeline: EditTimeline, state: EngineState = Depends(get_state)) -> EditProject:
    return state.edit.save(pid, timeline)


@router.delete("/edit/projects/{pid}", status_code=204)
def delete_project(pid: str, state: EngineState = Depends(get_state)) -> None:
    state.edit.delete(pid)


@router.get("/edit/projects/{pid}/assets", response_model=list[EditAsset])
def list_assets(pid: str, state: EngineState = Depends(get_state)) -> list[EditAsset]:
    return state.edit.assets(pid)


@router.post("/edit/projects/{pid}/assets", response_model=list[EditAsset])
def add_assets(pid: str, files: list[UploadFile] = File(default=[]), paths: str = Form("[]"),
               source: Literal["import", "record"] = Form("import"), state: EngineState = Depends(get_state)) -> list[EditAsset]:
    """Nhập audio/video (upload, hoặc đường dẫn file trên máy khi chạy trong app desktop)."""
    from pathlib import Path

    out: list[EditAsset] = []
    for f in files:
        tmp = save_upload(state, f)
        try:
            out.append(state.edit.import_file(pid, tmp, Path(f.filename or "audio").stem, source))
        finally:
            tmp.unlink(missing_ok=True)
    for p in json.loads(paths or "[]"):
        path = Path(p)
        if not path.is_file():
            raise EngineError("BAD_FILE", str(path))
        out.append(state.edit.import_file(pid, path, path.stem, source))
    if not out:
        raise EngineError("BAD_REQUEST", "chưa chọn file")
    return out


@router.get("/edit/projects/{pid}/assets/{aid}/audio", response_class=FileResponse)
def asset_audio(pid: str, aid: str, state: EngineState = Depends(get_state)) -> FileResponse:
    return FileResponse(state.edit.asset_path(pid, aid), media_type="audio/wav")


@router.post("/edit/projects/from-job", response_model=EditProject)
def project_from_job(req: FromJob, state: EngineState = Depends(get_state)) -> EditProject:
    """Mở kết quả của trang Đọc văn bản / Đổi giọng trong Edit Audio (TTS kèm lời thoại theo từng câu)."""
    job = state.queue.get(req.job_id)
    if job.status != "done" or job.kind not in ("tts", "sts"):
        raise EngineError("BAD_REQUEST", "chỉ mở được kết quả TTS / đổi giọng đã xong")
    fid = job.files.get("output")
    if not fid or fid not in state.files:
        raise EngineError("NOT_FOUND", "không còn file kết quả")
    path, _name = state.files[fid]
    audio, sr = audio_io.load(path)
    words: list[EditWord] | None = None
    if job.kind == "tts" and job.sentences:
        render = state.extras.get(f"tts:{job.id}")
        pause = (render.pause_ms if render else 250) / 1000
        words, t = [], 0.0
        for s in job.sentences:
            d = s.duration_sec or 0.0
            words += ops.spread_words(s.text, t, d)
            t += d + pause
    project = state.edit.create(job.label)
    asset = state.edit.add_asset(project.id, audio, sr, job.label, "job", words=words)
    track = EditTrack(id="t1", name="Audio 1", kind="voice" if job.kind == "tts" else "audio")
    clip = EditClip(id="c1", track_id=track.id, asset_id=asset.id, start=0.0, offset=0.0, duration=asset.duration_sec)
    return state.edit.save(project.id, EditTimeline(name=project.name, tracks=[track], clips=[clip]))


@router.post("/edit/projects/from-file", response_model=EditProject)
def project_from_file(req: FromFile, state: EngineState = Depends(get_state)) -> EditProject:
    """Mở một file engine đã tạo (vd. bản ghi đổi giọng trực tiếp) thành dự án Edit Audio."""
    from pathlib import Path

    item = state.files.get(req.file_id)
    if not item or not item[0].exists():
        raise EngineError("NOT_FOUND", f"file {req.file_id}")
    path, name = item
    label = (req.name or Path(name).stem)[:80]
    project = state.edit.create(label)
    asset = state.edit.import_file(project.id, path, label, "record")
    track = EditTrack(id="t1", name="Audio 1", kind="voice")
    clip = EditClip(id="c1", track_id=track.id, asset_id=asset.id, start=0.0, offset=0.0, duration=asset.duration_sec)
    return state.edit.save(project.id, EditTimeline(name=project.name, tracks=[track], clips=[clip]))


@router.post("/edit/projects/{pid}/ops", response_model=JobRef)
def run_op(pid: str, req: EditOp, state: EngineState = Depends(get_state)) -> JobRef:
    store = state.edit
    store.dir(pid)  # 404 nếu không có dự án
    for aid in _asset_ids(req):
        store.asset(pid, aid)
    # Báo lỗi thiếu model / tham số ngay khi bấm, không phải giữa chừng job
    if isinstance(req, SeparateOp):
        state.catalog.require(DEMUCS_ID)
    if isinstance(req, ConvertOp) and not state.voices.get(req.profile_id).rvc_model:
        raise EngineError("NO_STS_VOICE")
    if isinstance(req, SpeakOp):
        state.voices.tts_ref(req.profile_id, req.variant_id)
    if isinstance(req, (FilterOp, ConvertOp)) and not req.segments:
        raise EngineError("BAD_REQUEST", "chưa chọn đoạn nào")
    if isinstance(req, FilterOp) and req.filter not in FILTERS:
        raise EngineError("BAD_REQUEST", req.filter)
    timeline = getattr(req, "timeline", None)
    if timeline is not None:
        store.save(pid, timeline)  # thao tác theo timeline dùng đúng bản app đang thấy

    def run(ctx: JobContext) -> None:
        ctx.log(f"{LABELS[req.op]} · {ctx.job.device}")
        ctx.job.result = _dispatch(state, ctx, pid, req)
        ctx.progress(1.0)

    job = state.queue.submit("mix" if req.op in LIGHT else "edit", LABELS[req.op], run)
    return JobRef(job_id=job.id)


def _asset_ids(req) -> list[str]:
    if hasattr(req, "asset_ids"):
        return list(req.asset_ids)
    if hasattr(req, "segments"):
        return [s.asset_id for s in req.segments]
    if hasattr(req, "asset_id"):
        return [req.asset_id]
    return []


def _dispatch(state: EngineState, ctx: JobContext, pid: str, req) -> dict:
    lang = None if getattr(req, "language", "auto") == "auto" else req.language
    if isinstance(req, TranscribeOp):
        return ops.run_transcribe(state, ctx, pid, req.asset_ids, lang)
    if isinstance(req, DiarizeOp):
        return ops.run_diarize(state, ctx, pid, req.asset_ids, req.num_speakers)
    if isinstance(req, SeparateOp):
        return ops.run_separate(state, ctx, pid, req.asset_ids)
    if isinstance(req, FilterOp):
        return ops.run_filter(state, ctx, pid, req.segments, req.filter, req.amount)
    if isinstance(req, ConvertOp):
        return ops.run_convert(state, ctx, pid, req.segments, req.profile_id, req.pitch)
    if isinstance(req, RetextOp):
        return ops.run_retext(state, ctx, pid, req.asset_id, req.offset, req.duration, req.text, req.keep_duration, lang, req.seed)
    if isinstance(req, SpeakOp):
        return ops.run_speak(state, ctx, pid, req.profile_id, req.variant_id, req.text, req.speed, req.seed)
    if isinstance(req, SilencesOp):
        return ops.run_silences(state, ctx, pid, req.timeline, req.track_ids, req.threshold_db, req.min_sec)
    if isinstance(req, DuckOp):
        return ops.run_duck(state, ctx, pid, req.timeline, req.music_track_ids, req.voice_track_ids, req.amount_db)
    if isinstance(req, RenderOp):
        return ops.run_render(state, ctx, pid, req.timeline, req.format, req.target_lufs, req.srt)
    raise EngineError("BAD_REQUEST", "thao tác không hợp lệ")
