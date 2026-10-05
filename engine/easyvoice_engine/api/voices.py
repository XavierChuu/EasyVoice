from __future__ import annotations

import shutil
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse

from ..core.errors import EngineError
from ..core.state import EngineState, ImportStaging
from ..schemas import ImportCheck, ImportInspection, ImportRequest, Profile, RefAnalysis, Transcript, VoiceUpdate
from ..services.registry import ASR_KEY
from ..services.rvc.import_pth import convert_pth
from ..services.voices import analyze_reference, clean_tags
from .deps import get_state, save_upload

router = APIRouter(tags=["voices"])


@router.get("/voices", response_model=list[Profile])
def list_voices(state: EngineState = Depends(get_state)) -> list[Profile]:
    return [state.voices.to_api(p) for p in state.voices.list()]


@router.post("/voices/analyze", response_model=RefAnalysis)
def analyze(file: UploadFile = File(...), state: EngineState = Depends(get_state)) -> RefAnalysis:
    path = save_upload(state, file)
    try:
        return analyze_reference(path)
    finally:
        path.unlink(missing_ok=True)


@router.post("/voices/transcribe", response_model=Transcript)
def transcribe(file: UploadFile = File(...), language: str = Form("vi"), state: EngineState = Depends(get_state)) -> Transcript:
    path = save_upload(state, file)
    try:
        return Transcript(text=state.models.get(ASR_KEY).transcribe(path, language))
    finally:
        path.unlink(missing_ok=True)


@router.post("/voices", response_model=Profile)
def create_quick(
    name: str = Form(...), language: Literal["vi", "en"] = Form("vi"), transcript: str = Form(...),
    consent: bool = Form(...), file: UploadFile = File(...), gender: str | None = Form(None),
    country: str | None = Form(None), region: str | None = Form(None), state: EngineState = Depends(get_state),
) -> Profile:
    tags = clean_tags(gender, country, region)
    path = save_upload(state, file)
    try:
        return state.voices.to_api(state.voices.create_quick(name, language, transcript, path, consent, tags))
    finally:
        path.unlink(missing_ok=True)


@router.patch("/voices/{voice_id}", response_model=Profile)
def update(voice_id: str, req: VoiceUpdate, state: EngineState = Depends(get_state)) -> Profile:
    sent = req.model_fields_set
    tags = {k: v for k, v in clean_tags(req.gender, req.country, req.region).items() if k in sent}
    return state.voices.to_api(state.voices.update(voice_id, req.name if "name" in sent else None, tags))


@router.delete("/voices/{voice_id}", status_code=204)
def delete(voice_id: str, state: EngineState = Depends(get_state)) -> None:
    import time

    p = state.voices.get(voice_id)
    job = state.queue.jobs.get(p.train_job_id or "")
    if job and job.status in ("queued", "running"):  # đang train: dừng hẳn rồi mới xóa thư mục
        state.queue.cancel(job.id)
        deadline = time.time() + 30
        while job.status == "running" and time.time() < deadline:
            time.sleep(0.1)
    if job:
        job.status = "cancelled"
        state.queue.emit(job)
    for key in (f"rvc:voice:{voice_id}", f"train:{voice_id}"):
        state.models.unload(key)
    state.voices.delete(voice_id)


@router.get("/voices/{voice_id}/preview", response_class=FileResponse)
def preview(voice_id: str, variant: str | None = None, state: EngineState = Depends(get_state)) -> FileResponse:
    return FileResponse(state.voices.preview_path(voice_id, variant))


@router.post("/voices/{voice_id}/variants", response_model=Profile)
def add_variant(
    voice_id: str, name: str = Form(...), transcript: str = Form(...), emotion: str | None = Form(None),
    file: UploadFile = File(...), state: EngineState = Depends(get_state),
) -> Profile:
    path = save_upload(state, file)
    try:
        return state.voices.to_api(state.voices.add_variant(voice_id, name, emotion, transcript, path))
    finally:
        path.unlink(missing_ok=True)


@router.delete("/voices/{voice_id}/variants/{variant_id}", response_model=Profile)
def delete_variant(voice_id: str, variant_id: str, state: EngineState = Depends(get_state)) -> Profile:
    return state.voices.to_api(state.voices.delete_variant(voice_id, variant_id))


@router.post("/voices/import/inspect", response_model=ImportInspection)
def inspect_import(files: list[UploadFile] = File(...), state: EngineState = Depends(get_state)) -> ImportInspection:
    names = [f.filename or "" for f in files]
    if any(n.lower().endswith(".evoice") for n in names):
        raise EngineError("NOT_IMPLEMENTED", "nhập .evoice có ở Phase 5")
    pth = next((f for f in files if (f.filename or "").lower().endswith(".pth")), None)
    if pth is None:
        raise EngineError("BAD_FILE", "cần file .pth (và .index nếu có)")
    idx = next((f for f in files if (f.filename or "").lower().endswith(".index")), None)
    token = uuid.uuid4().hex[:12]
    staging = state.paths.tmp / f"import_{token}"
    staging.mkdir(parents=True)
    pth_path = save_upload(state, pth)
    index_path = None
    if idx:
        index_path = staging / "model.index"
        shutil.move(save_upload(state, idx), index_path)
    label = " + ".join(n for n in (pth.filename, idx.filename if idx else None) if n)
    try:
        meta = convert_pth(pth_path, staging / "converted")
    except EngineError as err:
        if err.code != "UNSAFE_MODEL":
            raise
        shutil.rmtree(staging, ignore_errors=True)
        return ImportInspection(
            token=token, kind="rvc", file_label=label, blocked=True, suggested_name="", author="", language="unknown",
            license="unknown", capabilities=[], sample_rate=0,
            checks=[ImportCheck(key="format", value="PyTorch pickle"),
                    ImportCheck(key="safeLoad", value="FAILED · code objects found", bad=True),
                    ImportCheck(key="result", value="BLOCKED", bad=True)])
    finally:
        pth_path.unlink(missing_ok=True)
    name = (pth.filename or "voice").rsplit(".", 1)[0]
    state.imports[token] = ImportStaging(dir=staging, index=index_path, meta=meta, name=name)
    return ImportInspection(
        token=token, kind="rvc", file_label=label, blocked=False, suggested_name=name, author="unknown",
        language="unknown", license="unknown", capabilities=["sts"], sample_rate=meta["sr"],
        checks=[ImportCheck(key="format", value=f"RVC {meta['version']} · {meta['sr'] // 1000} kHz"),
                ImportCheck(key="safeLoad", value="weights_only · isolated process · OK"),
                ImportCheck(key="convert", value=".pth → .safetensors"),
                ImportCheck(key="index", value="faiss · OK" if index_path else "missing · lower similarity", bad=not index_path)])


@router.post("/voices/import", response_model=Profile)
def do_import(req: ImportRequest, state: EngineState = Depends(get_state)) -> Profile:
    st = state.imports.pop(req.token, None)
    if st is None:
        raise EngineError("NOT_FOUND", "phiên nhập đã hết hạn, hãy chọn lại file")
    try:
        return state.voices.to_api(state.voices.import_rvc(req.name or st.name, st.dir / "converted", st.index, st.meta))
    finally:
        shutil.rmtree(st.dir, ignore_errors=True)


@router.post("/voices/{voice_id}/export")
def export_voice(voice_id: str, state: EngineState = Depends(get_state)) -> None:
    state.voices.get(voice_id)
    raise EngineError("NOT_IMPLEMENTED", "xuất .evoice có ở Phase 5")


