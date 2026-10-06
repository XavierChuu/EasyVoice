"""Đổi giọng trực tiếp (spec 3.4 / Phase 4): micro → RVC → loa, toàn bộ luồng âm thanh chạy trong Python.

- Thiết bị do Python mở trực tiếp bằng sounddevice (vào / ra có thể là hai thiết bị khác nhau, vd. micro USB → VB-Cable).
- Ba luồng: callback micro đẩy từng block vào hàng đợi → luồng xử lý chạy RVC (thuật toán của RVC gui_v1: ngữ cảnh +
  SOLA + crossfade) → callback loa lấy block ra. Loa hết dữ liệu = underrun (GPU không kịp), được đếm và báo lên UI.
- Ghi trực tiếp ra file WAV (không cần OBS / phần mềm thu khác), có thể chạy chỉ-ghi-file không cần thiết bị ra.
- Đổi pitch / noise gate / giọng khi đang chạy; giọng mới nạp ở luồng riêng rồi mới tráo để không bị ngắt tiếng.

Lớp AudioIO tách riêng để test được luồng xử lý mà không cần card âm thanh (FakeIO)."""

from __future__ import annotations

import collections
import logging
import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from .. import audio_io
from .infer import HOP_16K, SR_16K, ConvertParams, convert

log = logging.getLogger(__name__)

PRESETS = {  # spec 3.4: Độ trễ thấp / Cân bằng / Chất lượng (khớp RT_PRESETS phía app)
    "low": {"block_ms": 100, "context_sec": 1.0, "crossfade_ms": 40},
    "balanced": {"block_ms": 160, "context_sec": 1.5, "crossfade_ms": 60},
    "quality": {"block_ms": 250, "context_sec": 2.0, "crossfade_ms": 80},
}


@dataclass
class StreamParams:
    sr: int = 48000
    block_ms: float = 160
    context_sec: float = 1.5
    crossfade_ms: float = 60
    gate_db: float = -45.0
    convert: ConvertParams = field(default_factory=ConvertParams)


@dataclass
class Voice:
    """Model RVC đang dùng (đổi được khi đang chạy)."""

    profile_id: str
    model: object
    index: object | None
    pitch_shift: float = 0.0  # pitch gợi ý của giọng (cộng thêm pitch người dùng chỉnh)


def db(x: np.ndarray) -> float:
    return max(-120.0, float(20 * np.log10(np.sqrt(np.mean(np.square(x, dtype=np.float64))) + 1e-9))) if x.size else -120.0


class BlockConverter:
    """Xử lý từng block ở sample rate thiết bị: giữ bộ đệm ngữ cảnh, chạy RVC trên cả bộ đệm nhưng chỉ giải mã phần
    đuôi (return_frames), nối block bằng SOLA (tìm độ lệch tương quan cao nhất) + crossfade sin²."""

    def __init__(self, encoder, f0x, voice: Voice, p: StreamParams) -> None:
        if p.sr % 100:
            raise ValueError("sample rate thiết bị phải chia hết cho 100")
        self.encoder, self.f0x, self.voice, self.p = encoder, f0x, voice, p
        zc = p.sr // 100  # 10 ms
        self.zc = zc
        self.block = max(1, round(p.block_ms / 10)) * zc
        self.sola_buffer = min(max(1, round(p.crossfade_ms / 10)) * zc, 4 * zc)
        self.sola_search = zc
        self.context = round(p.context_sec * 100) * zc
        self.total = self.context + self.sola_buffer + self.sola_search + self.block
        self.need = self.block + self.sola_buffer + self.sola_search
        self.input_buf = np.zeros(self.total, dtype=np.float32)
        self.sola_prev = np.zeros(self.sola_buffer, dtype=np.float32)
        t = np.linspace(0.0, 1.0, self.sola_buffer, dtype=np.float32)
        self.fade_in = np.sin(0.5 * np.pi * t) ** 2
        self.fade_out = 1.0 - self.fade_in

    @property
    def algorithmic_latency_ms(self) -> float:
        return (self.sola_buffer + self.sola_search) / self.p.sr * 1000

    def process(self, x: np.ndarray) -> np.ndarray:
        x = x.astype(np.float32, copy=False)
        if db(x) < self.p.gate_db:  # noise gate
            x = np.zeros_like(x)
        self.input_buf = np.concatenate([self.input_buf[len(x):], x])
        a16 = audio_io.resample(self.input_buf, self.p.sr, SR_16K)
        a16 = a16[len(a16) % HOP_16K:]  # độ dài chia hết cho hop 10 ms của 16 kHz
        v = self.voice
        params = ConvertParams(pitch_shift=self.p.convert.pitch_shift + v.pitch_shift, index_rate=self.p.convert.index_rate,
                               protect=self.p.convert.protect)
        y = convert(v.model, self.encoder, self.f0x, v.index, a16, params, return_frames=self.need // self.zc)
        y = audio_io.resample(y, v.model.sr, self.p.sr)  # type: ignore[attr-defined]
        if len(y) < self.need:
            y = np.pad(y, (self.need - len(y), 0))
        y = y[-self.need:].astype(np.float32)
        head = y[: self.sola_buffer + self.sola_search]
        corr = np.correlate(head, self.sola_prev, mode="valid")
        energy = np.sqrt(np.convolve(head * head, np.ones(self.sola_buffer, dtype=np.float32), mode="valid") + 1e-8)
        off = int(np.argmax(corr / energy))
        y = y[off:]
        y[: self.sola_buffer] = y[: self.sola_buffer] * self.fade_in + self.sola_prev * self.fade_out
        self.sola_prev = y[self.block: self.block + self.sola_buffer].copy()
        return y[: self.block]


class AudioIO(Protocol):
    """Nguồn vào / đích ra. start() gọi on_input(block) mỗi khi có block micro; pull() trả block cho loa."""

    sr: int
    input_latency_ms: float
    output_latency_ms: float

    def start(self, on_input: Callable[[np.ndarray], None], pull: Callable[[int], np.ndarray] | None) -> None: ...

    def stop(self) -> None: ...


class SoundDeviceIO:
    """Micro + loa thật (sounddevice/PortAudio). output_id None = chỉ ghi file, không phát ra thiết bị nào."""

    def __init__(self, input_id: int | None, output_id: int | None, block: int, sr: int) -> None:
        self.input_id, self.output_id, self.block, self.sr = input_id, output_id, block, sr
        self.input_latency_ms = self.output_latency_ms = 0.0
        self._streams: list = []

    @staticmethod
    def pick_sr(input_id: int | None, output_id: int | None) -> int:
        import sounddevice as sd

        for sr in (48000, 44100, 32000, 16000):
            try:
                sd.check_input_settings(device=input_id, samplerate=sr, channels=1, dtype="float32")
                if output_id is not None:
                    sd.check_output_settings(device=output_id, samplerate=sr, channels=1, dtype="float32")
                return sr
            except Exception:  # noqa: BLE001 — thử sample rate khác
                continue
        raise RuntimeError("thiết bị không hỗ trợ sample rate 48/44,1/32/16 kHz")

    def start(self, on_input, pull) -> None:
        import sounddevice as sd

        def cb_in(indata, frames, _t, status):
            if status.input_overflow:
                log.debug("input overflow")
            on_input(indata[:, 0].copy())

        def cb_out(outdata, frames, _t, status):
            outdata[:, 0] = pull(frames)

        ins = sd.InputStream(device=self.input_id, samplerate=self.sr, channels=1, dtype="float32", blocksize=self.block,
                             latency="low", callback=cb_in)
        self._streams.append(ins)
        if pull is not None and self.output_id is not None:
            out = sd.OutputStream(device=self.output_id, samplerate=self.sr, channels=1, dtype="float32",
                                  blocksize=self.block, latency="low", callback=cb_out)
            self._streams.append(out)
            self.output_latency_ms = float(out.latency) * 1000
        self.input_latency_ms = float(ins.latency) * 1000
        for s in self._streams:
            s.start()

    def stop(self) -> None:
        for s in self._streams:
            try:
                s.stop()
                s.close()
            except Exception:  # noqa: BLE001
                pass
        self._streams = []


class FakeIO:
    """Thay card âm thanh trong test: đẩy audio có sẵn theo từng block đúng nhịp thời gian thực (hoặc nhanh hơn)."""

    def __init__(self, audio: np.ndarray, sr: int, block: int, speed: float = 1.0, with_output: bool = True) -> None:
        self.audio, self.sr, self.block, self.speed, self.with_output = audio, sr, block, speed, with_output
        self.input_latency_ms = self.output_latency_ms = 0.0
        self.played: list[np.ndarray] = []
        self._stop = threading.Event()
        self.done = threading.Event()

    def start(self, on_input, pull) -> None:
        def run():
            for i in range(0, len(self.audio) - self.block + 1, self.block):
                if self._stop.is_set():
                    break
                on_input(self.audio[i: i + self.block].astype(np.float32))
                time.sleep(self.block / self.sr / self.speed)
                if pull is not None and self.with_output:
                    self.played.append(pull(self.block))
            self.done.set()

        threading.Thread(target=run, daemon=True).start()

    def stop(self) -> None:
        self._stop.set()


class Recorder:
    """Ghi WAV ở luồng riêng (không chặn luồng xử lý)."""

    def __init__(self, path: Path, sr: int) -> None:
        import soundfile as sf

        path.parent.mkdir(parents=True, exist_ok=True)
        self.path, self.sr = path, sr
        self.frames = 0
        self._q: queue.Queue = queue.Queue()
        self._f = sf.SoundFile(str(path), "w", samplerate=sr, channels=1, subtype="PCM_16")
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def _run(self) -> None:
        while (block := self._q.get()) is not None:
            self._f.write(np.clip(block, -1, 1))
        self._f.close()

    def write(self, block: np.ndarray) -> None:
        self.frames += len(block)
        self._q.put(block)

    def close(self) -> float:
        self._q.put(None)
        self._t.join(timeout=10)
        return self.frames / self.sr


@dataclass
class Stats:
    running: bool = False
    in_db: float = -120.0
    out_db: float = -120.0
    latency_ms: float = 0.0
    underrun: bool = False
    underruns: int = 0
    proc_ms: float = 0.0
    recording: bool = False
    record_sec: float = 0.0
    profile_id: str | None = None


class RealtimeSession:
    """Một phiên live. converter_factory(voice) → BlockConverter (tạo lại khi đổi giọng để giữ đúng sample rate model)."""

    def __init__(self, io: AudioIO, conv: BlockConverter, on_error: Callable[[Exception], None] | None = None) -> None:
        self.io, self.conv = io, conv
        self.on_error = on_error
        self.stats = Stats(profile_id=conv.voice.profile_id)
        self._in: queue.Queue = queue.Queue(maxsize=64)
        self._out: collections.deque[np.ndarray] = collections.deque()
        self._out_lock = threading.Lock()
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None
        self._recorder: Recorder | None = None
        self._rec_lock = threading.Lock()
        self._last_underrun = 0.0
        self._primed = False
        self._pending_voice: Voice | None = None

    # ----- điều khiển -----
    def start(self, with_output: bool) -> None:
        self.stats.running = True
        self._worker = threading.Thread(target=self._loop, name="rt-worker", daemon=True)
        self._worker.start()
        self.io.start(self._on_input, self._pull if with_output else None)

    def stop(self) -> tuple[Path, float] | None:
        self._stop.set()
        self.io.stop()
        self._in.put(None)
        if self._worker:
            self._worker.join(timeout=5)
        self.stats.running = False
        return self.stop_recording()

    def set_voice(self, voice: Voice) -> None:
        self._pending_voice = voice  # tráo ở đầu block kế tiếp trong luồng xử lý

    def start_recording(self, path: Path) -> None:
        with self._rec_lock:
            if self._recorder is None:
                self._recorder = Recorder(path, self.io.sr)
                self.stats.recording, self.stats.record_sec = True, 0.0

    def stop_recording(self) -> tuple[Path, float] | None:
        with self._rec_lock:
            rec, self._recorder = self._recorder, None
            self.stats.recording = False
        if rec is None:
            return None
        return rec.path, rec.close()

    # ----- luồng âm thanh -----
    def _on_input(self, block: np.ndarray) -> None:
        self.stats.in_db = db(block)
        try:
            self._in.put_nowait(block)
        except queue.Full:  # xử lý quá chậm: bỏ block cũ nhất để không trễ dồn
            try:
                self._in.get_nowait()
                self._in.put_nowait(block)
            except queue.Empty:
                pass

    def _pull(self, frames: int) -> np.ndarray:
        with self._out_lock:
            if self._out:
                return self._fit(self._out.popleft(), frames)
        if self._primed:
            self.stats.underruns += 1
            self._last_underrun = time.monotonic()
        return np.zeros(frames, dtype=np.float32)

    @staticmethod
    def _fit(block: np.ndarray, frames: int) -> np.ndarray:
        if len(block) == frames:
            return block
        return np.pad(block, (0, frames - len(block))) if len(block) < frames else block[:frames]

    def _loop(self) -> None:
        proc = 0.0
        while not self._stop.is_set():
            block = self._in.get()
            if block is None:
                break
            if self._pending_voice is not None:
                self.conv.voice, self._pending_voice = self._pending_voice, None
                self.stats.profile_id = self.conv.voice.profile_id
            t0 = time.perf_counter()
            try:
                y = self.conv.process(block)
            except Exception as exc:  # noqa: BLE001
                log.exception("realtime block failed")
                if self.on_error:
                    self.on_error(exc)
                break
            dt = (time.perf_counter() - t0) * 1000
            proc = dt if proc == 0 else 0.8 * proc + 0.2 * dt
            with self._out_lock:
                self._out.append(y)
                while len(self._out) > 4:  # giữ hàng đợi ngắn: trễ không tăng dần
                    self._out.popleft()
                depth = len(self._out)
            self._primed = True
            with self._rec_lock:
                if self._recorder is not None:
                    self._recorder.write(y)
                    self.stats.record_sec = self._recorder.frames / self.io.sr
            self.stats.out_db = db(y)
            self.stats.proc_ms = proc
            block_ms = self.conv.block / self.io.sr * 1000
            # Trễ đầu-cuối ước tính: gom block + xử lý + SOLA + hàng đợi loa + buffer thiết bị vào/ra
            self.stats.latency_ms = round(block_ms + proc + self.conv.algorithmic_latency_ms + max(0, depth - 1) * block_ms
                                          + self.io.input_latency_ms + self.io.output_latency_ms)
            self.stats.underrun = time.monotonic() - self._last_underrun < 1.0
