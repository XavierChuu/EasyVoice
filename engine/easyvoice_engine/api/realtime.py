"""API đổi giọng trực tiếp (Phase 4). Lệnh qua REST; VU meter, độ trễ, underrun đẩy qua WS /ws/realtime (10 lần/s).

Real-time giữ GPU độc quyền (JobQueue.acquire_realtime): đang có job nặng thì không bật được, đang live thì job nặng mới
bị từ chối. Bản ghi (thu trực tiếp giọng đã đổi) lưu ở outputs/recordings/, nghe / tải / mở trong Edit Audio được."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from ..core.errors import EngineError
from ..core.job_queue import ApiModel
from ..core.state import EngineState
from ..services.registry import CONTENTVEC_KEY, RMVPE_KEY, ensure_rvc_voice
from .deps import get_state

router = APIRouter(tags=["realtime"])
log = logging.getLogger(__name__)
KEY = "realtime"


class RealtimeStart(ApiModel):
    profile_id: str
    input_id: str = ""  # "" = micro mặc định
    output_id: str | None = None  # None / "" = không phát ra thiết bị nào (chỉ ghi file)
    preset: Literal["low", "balanced", "quality"] = "balanced"
    block_ms: float | None = None
    context_sec: float | None = None
    crossfade_ms: float | None = None
    pitch: float = 0.0
    gate_db: float = -45.0
    index_rate: float = 0.3
    protect: float = 0.33
    record: bool = False
    preload_profile_ids: list[str] = []  # giọng gán phím tắt: nạp sẵn để đổi tức thì


class RealtimeUpdate(ApiModel):
    pitch: float | None = None
    gate_db: float | None = None
    profile_id: str | None = None


class RealtimeStatus(ApiModel):
    running: bool
    in_db: float = -120.0
    out_db: float = -120.0
    latency_ms: float = 0.0
    underrun: bool = False
    underruns: int = 0
    proc_ms: float = 0.0
    recording: bool = False
    record_sec: float = 0.0
    profile_id: str | None = None
    sample_rate: int | None = None
    block_ms: float | None = None
    error: str | None = None


class Recording(ApiModel):
    id: str
    name: str
    created_at: str
    duration_sec: float
    profile_name: str
    file_id: str


class RecordToggle(ApiModel):
    on: bool


class RealtimeStopResult(ApiModel):
    recording: Recording | None = None


# ---------------------------------------------------------------- bản ghi
def _rec_dir(state: EngineState) -> Path:
    d = state.paths.outputs / "recordings"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _recording(state: EngineState, meta_path: Path) -> Recording | None:
    try:
        m = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    wav = meta_path.with_suffix(".wav")
    if not wav.exists():
        return None
    fid = state.extras.setdefault("rec_files", {}).get(m["id"])
    if fid is None or fid not in state.files:
        fid = state.register_file(wav, wav.name)
        state.extras["rec_files"][m["id"]] = fid
    return Recording(id=m["id"], name=wav.name, created_at=m["created_at"], duration_sec=m["duration_sec"],
                     profile_name=m.get("profile_name", ""), file_id=fid)


def _finish_recording(state: EngineState, result: tuple[Path, float] | None, profile_name: str) -> Recording | None:
    if result is None:
        return None
    path, dur = result
    if dur < 0.2:
        path.unlink(missing_ok=True)
        return None
    rid = path.stem.split("_")[-1]
    meta = path.with_suffix(".json")
    meta.write_text(json.dumps({"id": rid, "created_at": datetime.now().isoformat(timespec="seconds"),
                                "duration_sec": round(dur, 2), "profile_name": profile_name}, ensure_ascii=False), encoding="utf-8")
    return _recording(state, meta)


def _new_record_path(state: EngineState, profile_name: str) -> Path:
    slug = re.sub(r"[^\w\-]+", "-", profile_name, flags=re.UNICODE).strip("-").lower() or "voice"
    return _rec_dir(state) / f"live-{datetime.now():%Y%m%d-%H%M%S}-{slug}_{uuid.uuid4().hex[:8]}.wav"


# ---------------------------------------------------------------- phiên live
class Live:
    def __init__(self, session, profile_name: str, sr: int, block_ms: float) -> None:
        self.session, self.profile_name, self.sr, self.block_ms = session, profile_name, sr, block_ms
        self.error: str | None = None


def _status(state: EngineState) -> RealtimeStatus:
    live: Live | None = state.extras.get(KEY)
    if live is None:
        return RealtimeStatus(running=False, error=state.extras.get("realtime_error"))
    s = live.session.stats
    return RealtimeStatus(running=s.running, in_db=round(s.in_db, 1), out_db=round(s.out_db, 1), latency_ms=s.latency_ms,
                          underrun=s.underrun, underruns=s.underruns, proc_ms=round(s.proc_ms, 1), recording=s.recording,
                          record_sec=round(s.record_sec, 1), profile_id=s.profile_id, sample_rate=live.sr,
                          block_ms=live.block_ms, error=live.error)


def _voice(state: EngineState, profile_id: str):
    from ..services.rvc.infer import Index
    from ..services.rvc.realtime import Voice

    p = state.voices.get(profile_id)
    if not p.rvc_model:
        raise EngineError("NO_STS_VOICE")
    d = state.voices.dir(profile_id)
    index = Index(d / p.rvc_index) if p.rvc_index and (d / p.rvc_index).exists() else None
    return Voice(profile_id=p.id, model=ensure_rvc_voice(state, profile_id), index=index, pitch_shift=p.pitch_shift), p.name


def _make_io(state: EngineState, input_id: str, output_id: str | None, block_ms: float):
    """(io, sample_rate, block). Test thay card âm thanh bằng state.extras["rt_io_factory"]."""
    factory = state.extras.get("rt_io_factory")
    if factory is not None:
        return factory(input_id, output_id, block_ms)
    from ..services.rvc.realtime import SoundDeviceIO

    try:
        import sounddevice  # noqa: F401
    except (ImportError, OSError) as exc:
        raise EngineError("AUDIO_DEVICE", f"không nạp được thư viện âm thanh (PortAudio): {exc}") from exc
    inp = int(input_id) if input_id not in ("", None) else None
    out = int(output_id) if output_id not in ("", None) else None
    try:
        sr = SoundDeviceIO.pick_sr(inp, out)
    except Exception as exc:  # noqa: BLE001
        raise EngineError("AUDIO_DEVICE", str(exc)) from exc
    block = max(1, round(block_ms / 10)) * (sr // 100)
    return SoundDeviceIO(inp, out, block, sr), sr, block


def _stop(state: EngineState) -> Recording | None:
    live: Live | None = state.extras.pop(KEY, None)
    if live is None:
        return None
    try:
        rec = _finish_recording(state, live.session.stop(), live.profile_name)
    finally:
        state.queue.release_realtime()
        _publish(state)
    return rec


def _publish(state: EngineState) -> None:
    state.hub.publish({"type": "realtime", "stats": _status(state).model_dump(by_alias=True)})


@router.post("/realtime/start", response_model=RealtimeStatus)
def realtime_start(req: RealtimeStart, state: EngineState = Depends(get_state)) -> RealtimeStatus:
    from ..services.rvc.infer import ConvertParams
    from ..services.rvc.realtime import PRESETS, BlockConverter, RealtimeSession, StreamParams

    if state.extras.get(KEY) is not None:
        raise EngineError("BAD_REQUEST", "đổi giọng trực tiếp đang chạy")
    if state.device() == "cpu" and os.environ.get("EASYVOICE_ALLOW_CPU_REALTIME") != "1":
        raise EngineError("REALTIME_GPU")
    state.voices.get(req.profile_id)
    state.queue.acquire_realtime()  # GPU_BUSY_JOB nếu đang có job nặng
    state.extras.pop("realtime_error", None)
    try:
        preset = PRESETS[req.preset]
        block_ms = req.block_ms or preset["block_ms"]
        voice, name = _voice(state, req.profile_id)
        encoder, f0x = state.models.get(CONTENTVEC_KEY), state.models.get(RMVPE_KEY)
        io, sr, _block = _make_io(state, req.input_id, req.output_id, block_ms)
        params = StreamParams(sr=sr, block_ms=block_ms, context_sec=req.context_sec or preset["context_sec"],
                              crossfade_ms=req.crossfade_ms or preset["crossfade_ms"], gate_db=req.gate_db,
                              convert=ConvertParams(pitch_shift=req.pitch, index_rate=req.index_rate, protect=req.protect))
        conv = BlockConverter(encoder, f0x, voice, params)
        conv.process(conv.input_buf[: conv.block] * 0)  # chạy thử một block: nạp kernel GPU trước khi mở thiết bị

        def on_error(exc: Exception) -> None:
            state.extras["realtime_error"] = f"{type(exc).__name__}: {exc}"[:300]
            threading.Thread(target=_stop, args=(state,), daemon=True).start()

        session = RealtimeSession(io, conv, on_error)
        live = Live(session, name, sr, block_ms)
        state.extras[KEY] = live
        if req.record:
            session.start_recording(_new_record_path(state, name))
        try:
            session.start(with_output=bool(req.output_id))
        except Exception as exc:  # noqa: BLE001 — thiết bị bận / không tồn tại
            state.extras.pop(KEY, None)
            session.stop()
            raise EngineError("AUDIO_DEVICE", str(exc)[:300]) from exc
    except BaseException:
        if state.extras.get(KEY) is None:
            state.queue.release_realtime()
        raise

    def preload() -> None:  # giọng gán phím tắt
        for pid in req.preload_profile_ids:
            if pid != req.profile_id and state.extras.get(KEY) is live:
                try:
                    _voice(state, pid)
                except Exception as exc:  # noqa: BLE001
                    log.warning("không nạp sẵn được giọng %s: %s", pid, exc)

    def ticker() -> None:  # cho UI không dùng WS riêng: đẩy số đo qua /ws/jobs
        while state.extras.get(KEY) is live:
            _publish(state)
            time.sleep(0.25)

    threading.Thread(target=preload, daemon=True).start()
    threading.Thread(target=ticker, daemon=True).start()
    log.info("realtime start %s · %d Hz · block %.0f ms · out=%s", name, sr, block_ms, req.output_id or "file")
    return _status(state)


@router.patch("/realtime", response_model=RealtimeStatus)
def realtime_update(req: RealtimeUpdate, state: EngineState = Depends(get_state)) -> RealtimeStatus:
    live: Live | None = state.extras.get(KEY)
    if live is None:
        raise EngineError("BAD_REQUEST", "đổi giọng trực tiếp chưa chạy")
    p = live.session.conv.p
    if req.pitch is not None:
        p.convert.pitch_shift = max(-24.0, min(24.0, req.pitch))
    if req.gate_db is not None:
        p.gate_db = req.gate_db
    if req.profile_id and req.profile_id != live.session.conv.voice.profile_id:
        voice, name = _voice(state, req.profile_id)  # đã nạp sẵn thì tức thì
        live.session.set_voice(voice)
        live.profile_name = name
    return _status(state)


@router.post("/realtime/record", response_model=RealtimeStopResult)
def realtime_record(req: RecordToggle, state: EngineState = Depends(get_state)) -> RealtimeStopResult:
    live: Live | None = state.extras.get(KEY)
    if live is None:
        raise EngineError("BAD_REQUEST", "đổi giọng trực tiếp chưa chạy")
    if req.on:
        live.session.start_recording(_new_record_path(state, live.profile_name))
        return RealtimeStopResult()
    return RealtimeStopResult(recording=_finish_recording(state, live.session.stop_recording(), live.profile_name))


@router.post("/realtime/stop", response_model=RealtimeStopResult)
def realtime_stop(state: EngineState = Depends(get_state)) -> RealtimeStopResult:
    return RealtimeStopResult(recording=_stop(state))


@router.get("/realtime/status", response_model=RealtimeStatus)
def realtime_status(state: EngineState = Depends(get_state)) -> RealtimeStatus:
    return _status(state)


@router.get("/realtime/recordings", response_model=list[Recording])
def recordings(state: EngineState = Depends(get_state)) -> list[Recording]:
    items = [r for m in _rec_dir(state).glob("*.json") if (r := _recording(state, m))]
    return sorted(items, key=lambda r: r.created_at, reverse=True)


@router.delete("/realtime/recordings/{rid}", status_code=204)
def delete_recording(rid: str, state: EngineState = Depends(get_state)) -> None:
    hits = [m for m in _rec_dir(state).glob(f"*_{rid}.json")] if re.fullmatch(r"[0-9a-f]{8}", rid) else []
    if not hits:
        raise EngineError("NOT_FOUND", f"bản ghi {rid}")
    for m in hits:
        m.with_suffix(".wav").unlink(missing_ok=True)
        m.unlink(missing_ok=True)


@router.get("/realtime/recordings/{rid}/audio", response_class=FileResponse)
def recording_audio(rid: str, download: bool = False, state: EngineState = Depends(get_state)) -> FileResponse:
    hits = [m for m in _rec_dir(state).glob(f"*_{rid}.wav")] if re.fullmatch(r"[0-9a-f]{8}", rid) else []
    if not hits:
        raise EngineError("NOT_FOUND", f"bản ghi {rid}")
    return FileResponse(hits[0], media_type="audio/wav", filename=hits[0].name if download else None)


@router.websocket("/ws/realtime")
async def ws_realtime(ws: WebSocket, token: str = "") -> None:
    """VU meter / độ trễ / underrun 10 lần mỗi giây (spec mục 4)."""
    state: EngineState = ws.app.state.engine
    if not hmac.compare_digest(token, state.token):
        await ws.close(code=4401)
        return
    await ws.accept()
    try:
        while True:
            await ws.send_json({"type": "realtime", "stats": _status(state).model_dump(by_alias=True)})
            await asyncio.sleep(0.1)
    except (WebSocketDisconnect, RuntimeError):
        pass
