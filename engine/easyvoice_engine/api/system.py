from __future__ import annotations

import sys

from fastapi import APIRouter, Depends

from ..core import device as dev
from ..core.state import EngineState
from ..core.errors import EngineError
from ..schemas import AudioDevice, AudioDevices, DownloadRequest, EngineSettings, Health, JobRef, ModelInfo, SettingsUpdate, SystemInfo
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


def _settings_view(state: EngineState) -> EngineSettings:
    from pathlib import Path

    st = state.settings
    want_models = Path(st.models_dir) if st.models_dir else state.paths.root / "models"
    want_voices = Path(st.voices_dir) if st.voices_dir else state.paths.root / "voices"
    return EngineSettings(device=st.device, models_dir=st.models_dir, voices_dir=st.voices_dir,
                          active_models_dir=str(state.paths.models), active_voices_dir=str(state.paths.voices),
                          restart_required=want_models.resolve() != state.paths.models.resolve()
                          or want_voices.resolve() != state.paths.voices.resolve())


@router.get("/system/settings", response_model=EngineSettings)
def get_settings(state: EngineState = Depends(get_state)) -> EngineSettings:
    return _settings_view(state)


@router.put("/system/settings", response_model=EngineSettings)
def put_settings(req: SettingsUpdate, state: EngineState = Depends(get_state)) -> EngineSettings:
    """Lưu vào settings.json. Thiết bị áp dụng ngay (gỡ model để nạp lại đúng thiết bị); đổi thư mục model / giọng
    có hiệu lực sau khi khởi động lại engine (restart_required)."""
    from pathlib import Path

    st = state.settings
    for field in ("models_dir", "voices_dir"):
        value = getattr(req, field)
        if value is None:
            continue
        value = value.strip()
        if value:
            path = Path(value)
            if not path.is_absolute():
                raise EngineError("BAD_REQUEST", f"cần đường dẫn đầy đủ: {value}")
            try:
                path.mkdir(parents=True, exist_ok=True)
                probe = path / ".easyvoice_write_test"
                probe.write_text("ok")
                probe.unlink()
            except OSError as exc:
                raise EngineError("BAD_REQUEST", f"không ghi được vào thư mục {value}: {exc}") from exc
        setattr(st, field, value)
    if req.device is not None and req.device != st.device:
        if state.queue.running() or state.queue.realtime:
            raise EngineError("GPU_BUSY_JOB", "đổi thiết bị khi không có tác vụ nào đang chạy")
        st.device = req.device
        state.models.unload_all()
    st.save(state.paths.settings_file)
    return _settings_view(state)
