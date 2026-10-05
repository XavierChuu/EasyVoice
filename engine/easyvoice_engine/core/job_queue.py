"""JobQueue (spec mục 5): mỗi lúc chỉ chạy 1 tác vụ GPU nặng (TTS, STS offline, train). Real-time giữ GPU độc quyền:
khi bật, job nặng mới bị từ chối; khi có job nặng đang chạy, không bật được real-time.
Mọi tác vụ dài trả job_id ngay; tiến độ đẩy qua listener (WebSocket /ws/jobs)."""

from __future__ import annotations

import logging
import threading
import time
import traceback
import uuid
from collections import deque
from collections.abc import Callable
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from .errors import EngineError, from_exception

log = logging.getLogger(__name__)

JobKind = Literal["tts", "sts", "train", "download"]
JobStatus = Literal["queued", "running", "paused", "done", "failed", "cancelled"]
HEAVY: set[str] = {"tts", "sts", "train"}


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, json_schema_serialization_defaults_required=True)


class TtsSentence(ApiModel):
    index: int
    text: str
    status: Literal["queued", "rendering", "done", "redo"] = "queued"
    progress: float = 0.0
    duration_sec: float | None = None
    profile_id: str | None = None  # giọng của câu (đoạn chọn giọng riêng); None = giọng của job
    variant_id: str | None = None


class Job(ApiModel):
    id: str
    kind: JobKind
    status: JobStatus = "queued"
    progress: float = 0.0
    label: str
    profile_id: str | None = None
    stage: str | None = None
    waiting_for: str | None = None
    log: list[str] = Field(default_factory=list)
    error: str | None = None
    error_detail: str | None = None
    device: str | None = None
    epoch: int | None = None
    total_epochs: int | None = None
    sentences: list[TtsSentence] | None = None
    files: dict[str, str] = Field(default_factory=dict)  # tên → file id (GET /files/{id})
    output_duration_sec: float | None = None
    created_at: float = Field(default_factory=time.time)


class Cancelled(Exception):
    pass


class JobContext:
    """Truyền vào hàm xử lý: báo tiến độ, ghi log, kiểm tra hủy."""

    def __init__(self, queue: "JobQueue", job: Job) -> None:
        self._q = queue
        self.job = job

    def progress(self, value: float, stage: str | None = None) -> None:
        self.check_cancel()
        self.job.progress = max(0.0, min(1.0, value))
        if stage is not None:
            self.job.stage = stage
        self._q.emit(self.job)

    def log(self, msg: str) -> None:
        log.info("[%s] %s", self.job.id, msg)
        self.job.log.append(msg)
        self.job.log = self.job.log[-500:]
        self._q.emit(self.job)

    def emit(self) -> None:
        self._q.emit(self.job)

    def check_cancel(self) -> None:
        if self._q.is_cancelled(self.job.id):
            raise Cancelled()


JobFn = Callable[[JobContext], None]


class JobQueue:
    def __init__(self, device: Callable[[], str]) -> None:
        self._device = device
        self.jobs: dict[str, Job] = {}
        self._fns: dict[str, JobFn] = {}
        self._queue: deque[str] = deque()
        self._cancel: set[str] = set()
        self._running: str | None = None
        self._realtime = False
        self._listeners: list[Callable[[Job], None]] = []
        self._cv = threading.Condition()
        self._stop = False
        self._worker = threading.Thread(target=self._loop, name="gpu-worker", daemon=True)
        self._worker.start()

    # ----- events -----
    def subscribe(self, fn: Callable[[Job], None]) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn)

    def emit(self, job: Job) -> None:
        snapshot = job.model_copy(deep=True)
        for fn in list(self._listeners):
            try:
                fn(snapshot)
            except Exception:  # noqa: BLE001 — listener lỗi không được làm hỏng job
                log.exception("listener failed")

    # ----- submit / control -----
    def submit(self, kind: JobKind, label: str, fn: JobFn, profile_id: str | None = None, **fields: object) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, label=label, profile_id=profile_id, **fields)
        with self._cv:
            if kind in HEAVY and self._realtime:
                raise EngineError("GPU_BUSY_REALTIME")
            self.jobs[job.id] = job
            self._fns[job.id] = fn
            if kind in HEAVY:
                self._queue.append(job.id)
                self._refresh_waiting()
                self._cv.notify_all()
            else:
                threading.Thread(target=self._run, args=(job.id,), daemon=True).start()
        self.emit(job)
        return job

    def requeue(self, job_id: str, fn: JobFn) -> Job:
        """Chạy lại một job đã xong (vd. render lại một câu TTS) — vẫn phải xếp hàng GPU."""
        with self._cv:
            if self._realtime:
                raise EngineError("GPU_BUSY_REALTIME")
            job = self.get(job_id)
            if job.status in ("queued", "running"):
                raise EngineError("BAD_REQUEST", "job is still running")
            self._fns[job_id] = fn
            self._cancel.discard(job_id)
            job.status, job.error, job.error_detail = "queued", None, None
            self._queue.append(job_id)
            self._refresh_waiting()
            self._cv.notify_all()
        self.emit(job)
        return job

    def get(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if job is None:
            raise EngineError("NOT_FOUND", f"job {job_id}")
        return job

    def cancel(self, job_id: str) -> Job:
        with self._cv:
            job = self.get(job_id)
            if job.status == "queued":
                if job_id in self._queue:
                    self._queue.remove(job_id)
                job.status = "cancelled"
                self._refresh_waiting()
            elif job.status == "running":
                self._cancel.add(job_id)  # hàm xử lý tự dừng ở lần check_cancel kế tiếp
        self.emit(job)
        return job

    def is_cancelled(self, job_id: str) -> bool:
        return job_id in self._cancel

    def running(self) -> Job | None:
        return self.jobs.get(self._running) if self._running else None

    # ----- real-time lock -----
    def acquire_realtime(self) -> None:
        with self._cv:
            if self._running:
                raise EngineError("GPU_BUSY_JOB", self.jobs[self._running].label)
            self._realtime = True
            self._refresh_waiting()

    def release_realtime(self) -> None:
        with self._cv:
            self._realtime = False
            self._refresh_waiting()
            self._cv.notify_all()

    @property
    def realtime(self) -> bool:
        return self._realtime

    # ----- worker -----
    def _refresh_waiting(self) -> None:
        holder = self.jobs[self._running].label if self._running else ("Real-time" if self._realtime else None)
        for jid in self._queue:
            j = self.jobs[jid]
            if j.waiting_for != holder:
                j.waiting_for = holder
                self.emit(j)

    def _loop(self) -> None:
        while True:
            with self._cv:
                while not self._stop and (not self._queue or self._realtime or self._running):
                    self._cv.wait()
                if self._stop:
                    return
                job_id = self._queue.popleft()
                self._running = job_id
                self._refresh_waiting()
            try:
                self._run(job_id)
            finally:
                with self._cv:
                    self._running = None
                    self._refresh_waiting()
                    self._cv.notify_all()

    def _run(self, job_id: str) -> None:
        job = self.jobs[job_id]
        job.status, job.waiting_for, job.device = "running", None, self._device()
        self.emit(job)
        ctx = JobContext(self, job)
        try:
            self._fns[job_id](ctx)
            job.status = "done"
            job.progress = 1.0
        except Cancelled:
            job.status = "paused" if job.kind == "train" else "cancelled"
        except Exception as exc:  # noqa: BLE001
            err = from_exception(exc)
            if err.code == "UNKNOWN":
                log.error("job %s failed:\n%s", job_id, traceback.format_exc())
            job.status, job.error, job.error_detail = "failed", err.code, err.detail
            job.log.append(f"ERROR {err.code} {err.detail}".strip())
        finally:
            self._cancel.discard(job_id)
            self.emit(job)

    def shutdown(self) -> None:
        with self._cv:
            self._stop = True
            self._cv.notify_all()
