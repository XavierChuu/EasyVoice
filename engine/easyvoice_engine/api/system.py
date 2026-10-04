from __future__ import annotations

import sys

from fastapi import APIRouter, Depends

from ..core import device as dev
from ..core.state import EngineState
from ..schemas import AudioDevice, AudioDevices, DownloadRequest, Health, JobRef, ModelInfo, SystemInfo
from ..services.models import run_download
from .deps import get_state

router = APIRouter(tags=["system"])
VIRTUAL_HINTS = ("cable", "vb-audio", "blackhole")


@router.get("/system/health", response_model=Health)
def health(state: EngineState = Depends(get_state)) -> Health:
    return Health(version=state.version)


@router.get("/system/info", response_model=SystemInfo)
def info(state: EngineState = Depends(get_state)) -> SystemInfo:
    device = state.device()
    mem = dev.memory(device)
    return SystemInfo(app_version=state.version, gpu=dev.gpu_name(), device=device, vram_total_gb=mem.total_gb,
                      vram_used_gb=mem.used_gb, disk_free_gb=dev.disk_free_gb(state.paths.models), driver_ok=True,
                      realtime=state.queue.realtime, loaded_models=state.models.loaded(), models=state.catalog.info())


@router.get("/models", response_model=list[ModelInfo])
def models(state: EngineState = Depends(get_state)) -> list[ModelInfo]:
    return state.catalog.info()


@router.post("/models/download", response_model=JobRef)
def download(req: DownloadRequest, state: EngineState = Depends(get_state)) -> JobRef:
    for mid in req.ids:
        state.catalog.get(mid)
    job = state.queue.submit("download", ",".join(req.ids), lambda ctx: run_download(ctx, state.catalog, req.ids))
    return JobRef(job_id=job.id)


@router.get("/audio/devices", response_model=AudioDevices)
def audio_devices() -> AudioDevices:
    try:
        import sounddevice as sd
    except (ImportError, OSError):
        return AudioDevices(inputs=[], outputs=[])
    ins, outs = [], []
    hostapi_default = sd.default.hostapi if sys.platform == "win32" else None
    for i, d in enumerate(sd.query_devices()):
        if hostapi_default is not None and d["hostapi"] != hostapi_default:
            continue  # Windows: chỉ lấy host API mặc định để không lặp thiết bị
        item = AudioDevice(id=str(i), name=d["name"], virtual=any(h in d["name"].lower() for h in VIRTUAL_HINTS))
        if d["max_input_channels"] > 0:
            ins.append(item)
        if d["max_output_channels"] > 0:
            outs.append(item)
    return AudioDevices(inputs=ins, outputs=outs)
