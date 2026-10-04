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
