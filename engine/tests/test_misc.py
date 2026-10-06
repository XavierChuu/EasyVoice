from __future__ import annotations

import hashlib
import http.server
import threading
from functools import partial

import numpy as np
import pytest

from easyvoice_engine.core.errors import EngineError
from easyvoice_engine.services import audio_io
from easyvoice_engine.services.models import download_file
from easyvoice_engine.services.tts.chunker import split_long, split_sentences
from easyvoice_engine.services.tts.text_normalize_en import normalize_en


@pytest.mark.parametrize(("text", "expected"), [
    ("I have 3 apples.", "I have three apples."),
    ("It costs $5.", "It costs five dollars."),
    ("Up 10% in 2026", "Up ten percent in twenty twenty-six"),
    ("Meet at 7:30 pm", "Meet at seven thirty P M"),
    ("The 21st century", "The twenty-first century"),
    ("Dr. Smith ran 5km", "Doctor Smith ran five kilometers"),
    ("1,250 people", "one thousand two hundred fifty people"),
    ("Pi is 3.14", "Pi is three point one four"),
])
def test_normalize_en(text, expected):
    assert normalize_en(text) == expected


def test_chunker():
    assert split_sentences("A. B? C!\nD") == ["A.", "B?", "C!", "D"]
    long = ", ".join(["một đoạn khá dài"] * 30)
    parts = split_long(long, 100)
    assert all(len(p) <= 100 for p in parts) and " ".join(parts).replace("  ", " ") == long


def test_crossfade_concat_lengths():
    sr = 24000
    a, b = np.ones(sr, np.float32), np.ones(sr, np.float32)
    out = audio_io.crossfade_concat([a, b], sr, pause_ms=250)
    assert len(out) == 2 * sr + sr // 4 and out[0] == 0 and abs(out[sr // 2] - 1) < 1e-6


@pytest.fixture
def http_server(tmp_path):
    payload = np.random.default_rng(0).bytes(3_000_000)
    (tmp_path / "srv").mkdir()
    (tmp_path / "srv" / "model.bin").write_bytes(payload)
    handler = partial(RangeHandler, directory=str(tmp_path / "srv"))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/model.bin", payload
    srv.shutdown()


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # hỗ trợ Range tối thiểu để test tải tiếp
        rng = self.headers.get("Range")
        if not rng:
            return super().do_GET()
        data = open(self.translate_path(self.path), "rb").read()
        start = int(rng.split("=")[1].split("-")[0])
        self.send_response(206)
        self.send_header("Content-Length", str(len(data) - start))
        self.end_headers()
        self.wfile.write(data[start:])


def test_download_resumes_from_part_file(tmp_path, http_server):
    url, payload = http_server
    dest = tmp_path / "out" / "model.bin"
    dest.parent.mkdir()
    dest.with_name("model.bin.part").write_bytes(payload[:1_000_000])  # giả lập rớt mạng giữa chừng
    seen = []
    download_file(url, dest, on_bytes=seen.append)
    assert dest.read_bytes() == payload
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == hashlib.sha256(payload).hexdigest()
    assert seen[0] == 1_000_000  # tính cả phần đã có


def test_engine_error_codes():
    e = EngineError("GPU_OOM")
    assert e.status == 507 and e.to_dict()["message"].startswith("Hết bộ nhớ GPU")
    assert EngineError("WHATEVER").code == "UNKNOWN"


def test_download_job_continues_past_failed_model_and_reports_reason(tmp_path, http_server):
    """Model lỗi (404) không chặn model khác; job báo lỗi rõ ràng thay vì đứng ở 0% mãi."""
    import json

    from conftest import TOKEN, wait_job
    from fastapi.testclient import TestClient

    from easyvoice_engine.core.state import EngineState
    from easyvoice_engine.main import create_app

    url, payload = http_server
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"models": [
        {"id": "bad", "name": "Bad", "role": "x", "group": "tts", "license": "MIT",
         "files": [{"path": "bad/x.bin", "url": url.replace("model.bin", "missing.bin"), "size_mb": 1}]},
        {"id": "good", "name": "Good", "role": "x", "group": "tts", "license": "MIT",
         "files": [{"path": "good/model.bin", "url": url, "size_mb": 3}]},
    ]}))
    import os

    os.environ["EASYVOICE_MANIFEST"] = str(manifest)
    try:
        st = EngineState.create(TOKEN, tmp_path / "data")
        c = TestClient(create_app(st))
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        job = wait_job(c, c.post("/models/download", json={"ids": ["bad", "good"]}).json()["jobId"])
        assert job["status"] == "failed" and job["error"] == "DOWNLOAD_FAILED"
        assert "Bad" in job["errorDetail"] and "404" in job["errorDetail"]
        assert (st.paths.models / "good" / "model.bin").read_bytes() == payload
        assert job["result"]["totalMb"] == 4.0
        st.queue.shutdown()
    finally:
        del os.environ["EASYVOICE_MANIFEST"]


class FlakyHandler(RangeHandler):
    """Lần đầu gửi một nửa file rồi cắt kết nối (giả lập rớt mạng giữa chừng); các lần sau trả đúng (có Range)."""

    cuts = 0

    def do_GET(self):
        if self.headers.get("Range") or FlakyHandler.cuts >= 1:
            return super().do_GET()
        FlakyHandler.cuts += 1
        data = open(self.translate_path(self.path), "rb").read()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data[: len(data) // 2])
        self.wfile.flush()
        self.connection.shutdown(2)


def test_download_retries_and_resumes_after_connection_drop(tmp_path):
    from easyvoice_engine.services.models import download_with_retry

    payload = np.random.default_rng(1).bytes(2_000_000)
    (tmp_path / "srv").mkdir()
    (tmp_path / "srv" / "f.bin").write_bytes(payload)
    FlakyHandler.cuts = 0
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(FlakyHandler, directory=str(tmp_path / "srv")))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        dest = tmp_path / "out" / "f.bin"
        seen, logs = [], []
        download_with_retry(f"http://127.0.0.1:{srv.server_address[1]}/f.bin", dest, seen.append, None, logs.append,
                            sleep=lambda s: None)
        assert dest.read_bytes() == payload
        assert any("thử lại" in x for x in logs)
        assert seen[-1] == len(payload) and max(seen) == len(payload)  # tiến độ tuyệt đối, không cộng trùng khi tải tiếp
    finally:
        srv.shutdown()


def test_manifest_hashes_are_well_formed():
    """sha256 sai định dạng làm model không bao giờ tải được (file bị xóa sau mỗi lần tải)."""
    import json
    import re

    from easyvoice_engine.services.models import ManifestFile, manifest_path

    for m in json.loads(manifest_path().read_text(encoding="utf-8"))["models"]:
        for f in m["files"]:
            assert f["sha256"] is None or re.fullmatch(r"[0-9a-f]{64}", f["sha256"]), f["path"]
    assert ManifestFile(path="x", url="u", sha256="abc").sha256 is None


def test_runtime_requirements_match_pyproject():
    """Bản đóng gói cài requirements/runtime.txt thay vì `-e .[...]`: phải đủ mọi thư viện engine cần."""
    import re
    import tomllib
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    py = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    want = list(py["dependencies"]) + [d for k, v in py["optional-dependencies"].items() if k != "dev" for d in v]
    lines = [x.strip() for x in (root / "requirements" / "runtime.txt").read_text(encoding="utf-8").splitlines()]
    have = {x for x in lines if x and not x.startswith("#")}
    assert set(want) <= have, set(want) - have
    torch_pins = {x for x in (root / "requirements" / "base.txt").read_text().splitlines() if x.startswith("torch")}
    assert torch_pins <= have and torch_pins <= set((root / "requirements" / "cpu.txt").read_text().splitlines())
    assert not any(re.match(r"-e\b", x) for x in have)
