from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse

from ..core.errors import EngineError
from ..core.state import EngineState, ImportStaging
from ..schemas import (ExportRequest, ExportResult, ImportCheck, ImportInspection, ImportRequest, Profile, RefAnalysis,
                       Transcript, VoiceUpdate)
from ..services.evoice import export_voice as export_voice_file, import_evoice, inspect_evoice
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


class _Src:
    """File nhập: upload (trình duyệt, xoá sau khi dùng) hoặc đường dẫn trên máy (app desktop — .evoice có thể nặng
    hàng GB, không đọc vào renderer)."""

    def __init__(self, name: str, path: Path, temp: bool):
        self.name, self.path, self.temp = name, path, temp

    def done(self) -> None:
        if self.temp:
            self.path.unlink(missing_ok=True)


def _sources(state: EngineState, files: list[UploadFile], paths: str) -> list[_Src]:
    out: list[_Src] = []
    for raw in json.loads(paths or "[]"):
        p = Path(raw)
        if not p.is_absolute() or not p.is_file():
            raise EngineError("BAD_FILE", f"không tìm thấy file {p.name}")
        out.append(_Src(p.name, p, temp=False))
    return out + [_Src(f.filename or "upload", save_upload(state, f), temp=True) for f in files]


@router.post("/voices/import/inspect", response_model=ImportInspection)
def inspect_import(
    files: list[UploadFile] = File(default=[]),
    paths: str = Form("[]", description="JSON: đường dẫn file trên máy (app desktop gửi đường dẫn thay vì upload)"),
    state: EngineState = Depends(get_state),
) -> ImportInspection:
    srcs = _sources(state, files, paths)
    try:
        return _inspect(state, srcs)
    finally:
        for s in srcs:
            s.done()


def _inspect(state: EngineState, srcs: list[_Src]) -> ImportInspection:
    pick = lambda ext: next((s for s in srcs if s.name.lower().endswith(ext)), None)  # noqa: E731
    evo = pick(".evoice")
    if evo is not None:
        return _inspect_evoice(state, evo)
    pth = pick(".pth")
    if pth is None:
        names = ", ".join(s.name for s in srcs) or "—"
        raise EngineError("BAD_FILE", f"{names}: cần file .evoice, hoặc .pth (kèm .index nếu có)")
    idx = pick(".index")
    token = uuid.uuid4().hex[:12]
    staging = state.paths.tmp / f"import_{token}"
    staging.mkdir(parents=True)
    index_path = None
    if idx:
        index_path = staging / "model.index"
        shutil.copy2(idx.path, index_path)
    label = " + ".join(s.name for s in (pth, idx) if s)
    try:
        meta = convert_pth(pth.path, staging / "converted")
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
    name = pth.name.rsplit(".", 1)[0] or "voice"
    state.imports[token] = ImportStaging(dir=staging, index=index_path, meta=meta, name=name)
    return ImportInspection(
        token=token, kind="rvc", file_label=label, blocked=False, suggested_name=name, author="unknown",
        language="unknown", license="unknown", capabilities=["sts"], sample_rate=meta["sr"],
        checks=[ImportCheck(key="format", value=f"RVC {meta['version']} · {meta['sr'] // 1000} kHz"),
                ImportCheck(key="safeLoad", value="weights_only · isolated process · OK"),
                ImportCheck(key="convert", value=".pth → .safetensors"),
                ImportCheck(key="index", value="faiss · OK" if index_path else "missing · lower similarity", bad=not index_path)])


def _inspect_evoice(state: EngineState, src: _Src) -> ImportInspection:
    token = uuid.uuid4().hex[:12]
    staging = state.paths.tmp / f"import_{token}"
    ins = inspect_evoice(src.path, staging / "files")
    m = ins.manifest
    if not ins.blocked:
        state.imports[token] = ImportStaging(dir=staging, index=None, meta=m, name=str(m.get("name") or ""), kind="evoice")
    caps = [c for c in m.get("capabilities") or [] if c in ("tts", "sts")]
    return ImportInspection(
        token=token, kind="evoice", file_label=src.name, blocked=ins.blocked,
        checks=[ImportCheck(key=k, value=v, bad=bad) for k, v, bad in ins.checks],
        suggested_name=str(m.get("name") or ""), author=str(m.get("author") or "unknown"),
        language=m.get("language") if m.get("language") in ("vi", "en") else "unknown",
        license=m.get("license") if m.get("license") in ("personal", "commercial", "noredist") else "unknown",
        capabilities=caps if not ins.blocked else [], created_at=(str(m.get("created_at"))[:10] if m.get("created_at") else None),
        sample_rate=int(m.get("sample_rate") or 0))


@router.post("/voices/import", response_model=Profile)
def do_import(req: ImportRequest, state: EngineState = Depends(get_state)) -> Profile:
    st = state.imports.pop(req.token, None)
    if st is None:
        raise EngineError("NOT_FOUND", "phiên nhập đã hết hạn, hãy chọn lại file")
    try:
        if st.kind == "evoice":
            return state.voices.to_api(import_evoice(state.voices, st.dir / "files", st.meta, req.name.strip()))
        return state.voices.to_api(state.voices.import_rvc(req.name or st.name, st.dir / "converted", st.index, st.meta))
    finally:
        shutil.rmtree(st.dir, ignore_errors=True)


@router.post("/voices/{voice_id}/export", response_model=ExportResult)
def export_voice(voice_id: str, req: ExportRequest, state: EngineState = Depends(get_state)) -> ExportResult:
    """Xuất .evoice (spec 3.5). Lưu vào thư mục app gửi lên (thư mục Tải về), không hợp lệ thì vào outputs/."""
    from pathlib import Path

    dest = Path(req.dest_dir) if req.dest_dir else None
    if dest is None or not dest.is_dir():
        dest = state.paths.outputs
    out = export_voice_file(state.voices, voice_id, req.include_model, req.include_ref, req.license, req.author, dest)
    return ExportResult(path=str(out), size_mb=round(out.stat().st_size / 1e6, 2), file_id=state.register_file(out, out.name))


