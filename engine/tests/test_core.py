from __future__ import annotations

import gc
import threading
import time
import weakref

import pytest

from easyvoice_engine.core.errors import EngineError
from easyvoice_engine.core.job_queue import JobQueue
from easyvoice_engine.core.model_manager import ModelManager


def test_model_manager_load_unload_20_times_no_leak():
    """Nghiệm thu Phase 1: load/unload 20 lần không rò bộ nhớ (CUDA: memory_allocated về mức ban đầu)."""
    import torch

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    mm = ModelManager(lambda: device)
    refs = []

    def loader(dev):
        m = torch.nn.Linear(2048, 2048).to(dev)
        refs.append(weakref.ref(m))
        return m

    mm.register("tts", loader, "tts")
    mm.register("rvc", loader, "rvc")
    gc.collect()  # tensor còn sót của test trước được giải phóng giữa chừng sẽ làm lệch mức nền
    base = torch.cuda.memory_allocated() if device.startswith("cuda") else 0
    for i in range(20):
        mm.get("tts" if i % 2 == 0 else "rvc")  # đổi tác vụ → model nhóm kia bị gỡ
        assert len(mm.loaded()) == 1
    mm.unload_all()
    gc.collect()
    assert mm.loaded() == []
    assert all(r() is None for r in refs)  # mọi model đã được giải phóng
    if device.startswith("cuda"):
        assert torch.cuda.memory_allocated() <= base


def test_model_manager_keeps_same_group_and_shared():
    mm = ModelManager(lambda: "cpu")
    for k, g in (("a", "rvc"), ("b", "rvc"), ("s", "shared"), ("t", "tts")):
        mm.register(k, lambda dev, k=k: object(), g)
    mm.get("a"), mm.get("b"), mm.get("s")
    assert mm.loaded() == ["a", "b", "s"]
    mm.get("t")
    assert mm.loaded() == ["s", "t"]


def test_job_queue_runs_one_heavy_job_at_a_time():
    q = JobQueue(lambda: "cpu")
    running, peak, lock = [0], [0], threading.Lock()

    def work(ctx):
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
        time.sleep(0.05)
        with lock:
            running[0] -= 1

    jobs = [q.submit("tts", f"j{i}", work) for i in range(4)]
    deadline = time.time() + 5
    while any(j.status != "done" for j in jobs) and time.time() < deadline:
        time.sleep(0.01)
    assert all(j.status == "done" for j in jobs) and peak[0] == 1
    q.shutdown()


def test_job_queue_cancel_and_realtime_lock():
    q = JobQueue(lambda: "cpu")
    started = threading.Event()

    def long(ctx):
        started.set()
        for _ in range(200):
            time.sleep(0.01)
            ctx.check_cancel()

    j = q.submit("sts", "long", long)
    started.wait(2)
    with pytest.raises(EngineError) as e:
        q.acquire_realtime()
    assert e.value.code == "GPU_BUSY_JOB"
    q.cancel(j.id)
    deadline = time.time() + 3
    while j.status == "running" and time.time() < deadline:
        time.sleep(0.01)
    assert j.status == "cancelled"
    q.acquire_realtime()
    with pytest.raises(EngineError) as e:
        q.submit("tts", "blocked", lambda ctx: None)
    assert e.value.code == "GPU_BUSY_REALTIME"
    q.release_realtime()
    q.shutdown()


def test_failed_job_reports_error_code():
    q = JobQueue(lambda: "cpu")

    def oom(ctx):
        raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")

    j = q.submit("tts", "x", oom)
    deadline = time.time() + 3
    while j.status in ("queued", "running") and time.time() < deadline:
        time.sleep(0.01)
    assert j.status == "failed" and j.error == "GPU_OOM"
    q.shutdown()
