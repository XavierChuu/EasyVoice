"""Phase 4: đổi giọng trực tiếp — luồng micro → RVC → loa chạy bằng card âm thanh giả (FakeIO), ghi file trực tiếp,
đổi giọng / pitch khi đang chạy, giữ GPU độc quyền. Model RVC/ContentVec/RMVPE khởi tạo ngẫu nhiên (CPU)."""

from __future__ import annotations

import io
import time

import numpy as np
import pytest
import soundfile as sf

from conftest import make_rvc_pth, voice_like
from easyvoice_engine.services.rvc.realtime import FakeIO

SR = 16000


@pytest.fixture
def live(client, dummy_rvc_assets, tmp_path, monkeypatch):
    monkeypatch.setenv("EASYVOICE_ALLOW_CPU_REALTIME", "1")
    state = dummy_rvc_assets
    ids = []
    for name in ("A", "B"):
        pth = make_rvc_pth(tmp_path / f"{name}.pth")
        with pth.open("rb") as f:
            ins = client.post("/voices/import/inspect", files=[("files", (f"{name}.pth", f))]).json()
        ids.append(client.post("/voices/import", json={"token": ins["token"], "name": f"Giọng {name}"}).json()["id"])
    ios = []

    def factory(input_id, output_id, block_ms):
        block = round(block_ms / 10) * (SR // 100)
        fio = FakeIO(voice_like(SR, 2.0), SR, block, speed=0.1, with_output=bool(output_id))  # CPU + model ngẫu nhiên: cho đủ thời gian xử lý
        ios.append(fio)
        return fio, SR, block

    state.extras["rt_io_factory"] = factory
    return client, state, ids, ios


def wait(cond, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_live_convert_record_switch_and_gpu_lock(live):
    client, state, (a, b), ios = live
    r = client.post("/realtime/start", json={"profileId": a, "inputId": "0", "outputId": "1", "preset": "low",
                                             "record": True, "preloadProfileIds": [b]})
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["running"] and st["sampleRate"] == SR and st["blockMs"] == 100 and st["recording"]
    assert state.queue.realtime
    # GPU độc quyền: job nặng mới bị từ chối
    assert client.post("/tts", json={"profileId": a, "text": "x"}).json()["code"] in ("GPU_BUSY_REALTIME", "BAD_REQUEST")
    assert client.post("/realtime/start", json={"profileId": a}).json()["code"] == "BAD_REQUEST"
    assert wait(lambda: client.get("/realtime/status").json()["latencyMs"] > 0)
    s = client.patch("/realtime", json={"pitch": 3, "gateDb": -60, "profileId": b}).json()
    assert wait(lambda: client.get("/realtime/status").json()["profileId"] == b)
    assert ios[0].done.wait(120)
    s = client.get("/realtime/status").json()
    assert -120 <= s["inDb"] <= 0 and s["recordSec"] > 1.0
    played = np.concatenate(ios[0].played)
    assert np.isfinite(played).all() and len(played) >= SR
    stop = client.post("/realtime/stop").json()
    rec = stop["recording"]
    assert rec and rec["durationSec"] > 1.0 and rec["profileName"] == "Giọng B"
    assert not state.queue.realtime and not client.get("/realtime/status").json()["running"]
    audio, sr = sf.read(io.BytesIO(client.get(f"/realtime/recordings/{rec['id']}/audio").content))
    assert sr == SR and abs(len(audio) / sr - rec["durationSec"]) < 0.05
    assert [x["id"] for x in client.get("/realtime/recordings").json()] == [rec["id"]]
    # Mở bản ghi trong Edit Audio
    proj = client.post("/edit/projects/from-file", json={"fileId": rec["fileId"]}).json()
    assert len(proj["clips"]) == 1 and abs(proj["assets"][0]["durationSec"] - rec["durationSec"]) < 0.05
    assert client.delete(f"/realtime/recordings/{rec['id']}").status_code == 204
    assert client.get("/realtime/recordings").json() == []


def test_record_only_without_output_and_toggle_recording(live):
    client, state, (a, _), ios = live
    st = client.post("/realtime/start", json={"profileId": a, "inputId": "0", "outputId": None, "preset": "low"}).json()
    assert st["running"] and not st["recording"]
    assert client.post("/realtime/record", json={"on": True}).status_code == 200
    assert wait(lambda: client.get("/realtime/status").json()["recordSec"] > 1.0, timeout=120)
    rec = client.post("/realtime/record", json={"on": False}).json()["recording"]
    assert rec and rec["durationSec"] > 1.0
    assert ios[0].played == []  # không phát ra thiết bị nào
    assert client.post("/realtime/stop").json()["recording"] is None


def test_realtime_needs_gpu_and_sts_voice(client, state, wav_file, monkeypatch):
    monkeypatch.delenv("EASYVOICE_ALLOW_CPU_REALTIME", raising=False)
    with wav_file.open("rb") as f:
        v = client.post("/voices", data={"name": "TTS only", "language": "vi", "transcript": "xin chào", "consent": "true"},
                        files={"file": ("ref.wav", f)}).json()
    if state.device() == "cpu":
        assert client.post("/realtime/start", json={"profileId": v["id"]}).json()["code"] == "REALTIME_GPU"
    monkeypatch.setenv("EASYVOICE_ALLOW_CPU_REALTIME", "1")
    assert client.post("/realtime/start", json={"profileId": v["id"]}).json()["code"] == "NO_STS_VOICE"
    assert not state.queue.realtime  # lỗi khi bật → trả lại GPU
