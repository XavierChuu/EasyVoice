"""Phase 3: huấn luyện RVC chạy dạng job — tiền xử lý → trích đặc trưng → train → index, hủy/tiếp tục từ checkpoint.
Chạy trên CPU với pretrained/encoder khởi tạo ngẫu nhiên và Demucs/Whisper giả (không cần tải model)."""

from __future__ import annotations

import io
import time

import numpy as np
import pytest
import soundfile as sf
import torch
from fastapi.testclient import TestClient

from conftest import TOKEN, voice_like, wait_job
from easyvoice_engine.services.registry import ASR_KEY, SEP_KEY


class FakeSeparator:
    def separate(self, audio, sr, on_progress=None):
        return audio * 0.9, audio * 0.1


class FakeWhisper:
    def transcribe(self, path, language):
        return "xin chào các bạn"

    def words(self, path, language):
        return []


def install_training_models(state):
    """Pretrained f0G/f0D ngẫu nhiên + file giữ chỗ cho model đã thay bằng bản giả."""
    from easyvoice_engine.services.rvc.train.config import CONFIG_40K
    from easyvoice_engine.services.rvc.train.trainer import build_nets

    cat = state.catalog
    nets = build_nets(CONFIG_40K, "cpu")
    g, d = cat.path("rvc-pretrained-v2-40k", 0), cat.path("rvc-pretrained-v2-40k", 1)
    g.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"model": nets.net_g.state_dict()}, g)
    torch.save({"model": nets.net_d.state_dict()}, d)
    for mid in ("contentvec", "rmvpe", "demucs-htdemucs", "whisper-small"):
        for f in cat.get(mid).files:
            p = state.paths.models / f.path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"placeholder")
    state.models.register(SEP_KEY, lambda device: FakeSeparator(), "sep")
    state.models.register(ASR_KEY, lambda device: FakeWhisper(), "asr")


@pytest.fixture
def train_state(dummy_rvc_assets, monkeypatch):
    monkeypatch.setenv("EASYVOICE_ALLOW_CPU_TRAIN", "1")
    install_training_models(dummy_rvc_assets)
    return dummy_rvc_assets


def dataset_files(tmp_path):
    sr = 44100
    gapped = tmp_path / "talk.wav"  # có khoảng nghỉ như nói chuyện
    sf.write(gapped, voice_like(sr, 24.0), sr)
    t = np.arange(int(sr * 9)) / sr  # 9 s đọc liền mạch (không có khoảng nghỉ dài)
    ph = 2 * np.pi * np.cumsum(150 + 25 * np.sin(2 * np.pi * 0.4 * t)) / sr
    cont = sum(np.sin(k * ph) / k for k in range(1, 6)) * 0.2 * (0.7 + 0.3 * np.sin(2 * np.pi * 1.1 * t))
    cont = np.concatenate([np.zeros(sr), cont, np.zeros(sr)]).astype(np.float32)
    continuous = tmp_path / "read.wav"
    sf.write(continuous, cont, sr)
    return [gapped, continuous]


def start_train(client, files, epochs, separate=True):
    handles = [f.open("rb") for f in files]
    try:
        return client.post("/train", data={"name": "Giọng train", "language": "vi", "preset": "fast", "separate": str(separate).lower(),
                                           "consent": "true", "epochs": str(epochs)},
                           files=[("files", (f.name, h, "audio/wav")) for f, h in zip(files, handles)])
    finally:
        for h in handles:
            h.close()


def test_training_end_to_end_then_sts_and_chain_tts(client, train_state, tmp_path):
    r = start_train(client, dataset_files(tmp_path), epochs=2)
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["capabilities"] == [] and v["trainJobId"]
    job = wait_job(client, v["trainJobId"], timeout=900)
    assert job["status"] == "done", job["log"][-5:]
    log = "\n".join(job["log"])
    assert "đã tách nhạc nền" in log and "Dataset:" in log and "dưới 8 phút" in log and "Index faiss" in log
    v = next(x for x in client.get("/voices").json() if x["id"] == v["id"])
    assert set(v["capabilities"]) == {"tts", "sts"} and v["trainJobId"] is None and v["sampleRate"] == 40000
    d = train_state.voices.dir(v["id"])
    for f in ("model.safetensors", "model.index", "rvc.json", "preview.wav", "ref.wav"):
        assert (d / f).exists(), f
    assert not (d / "train" / "ckpt").exists()  # checkpoint lớn đã dọn

    # Đổi giọng offline với giọng vừa train
    src = tmp_path / "in.wav"
    sf.write(src, voice_like(22050, 2.0), 22050)
    with src.open("rb") as f:
        sts = client.post("/sts/offline", data={"profileId": v["id"], "separate": "true"}, files={"file": ("in.wav", f)}).json()
    sjob = wait_job(client, sts["jobId"], timeout=300)
    assert sjob["status"] == "done" and any("Đã tách nhạc nền" in x for x in sjob["log"])
    out, sr = sf.read(io.BytesIO(client.get(f"/sts/{sjob['id']}/audio?which=b").content))
    assert sr == 22050 and abs(len(out) / sr - 2.0) < 0.05

    # TTS "Qua RVC": F5 (giả) đọc bằng ref tự chọn, rồi đổi giọng bằng RVC → 40 kHz
    tts = client.post("/tts", json={"profileId": v["id"], "text": "Xin chào. Hẹn gặp lại!", "mode": "chain"}).json()
    tjob = wait_job(client, tts["jobId"], timeout=300)
    assert tjob["status"] == "done", tjob["log"]
    audio, sr = sf.read(io.BytesIO(client.get(f"/tts/{tjob['id']}/audio").content))
    assert sr == 40000 and len(audio) > 0


def test_pause_resume_and_recover_after_restart(client, train_state, tmp_path):
    v = start_train(client, dataset_files(tmp_path), epochs=6, separate=False).json()
    job_id = v["trainJobId"]
    t0 = time.time()
    while time.time() - t0 < 600:
        j = client.get(f"/jobs/{job_id}").json()
        if j["stage"] == "train" and (j["epoch"] or 0) >= 3:
            break
        assert j["status"] in ("queued", "running"), j["log"][-3:]
        time.sleep(0.2)
    client.delete(f"/jobs/{job_id}")  # người dùng bấm Tạm dừng
    j = wait_job(client, job_id, until=("paused", "failed", "done"))
    assert j["status"] == "paused", j["log"][-3:]
    assert any("checkpoint giữ ở epoch" in x for x in j["log"])

    # Tắt engine (mất trạng thái trong bộ nhớ) rồi mở lại trên cùng thư mục dữ liệu
    from easyvoice_engine.core.state import EngineState
    from easyvoice_engine.main import create_app

    train_state.queue.shutdown()
    train_state.models.unload_all()  # engine cũ "tắt": giải phóng model
    st2 = EngineState.create(TOKEN, train_state.paths.root)
    install_training_models(st2)
    from easyvoice_engine.services.registry import CONTENTVEC_KEY, RMVPE_KEY
    from easyvoice_engine.services.rvc.infer import ContentEncoder, F0Extractor

    st2.models.register(CONTENTVEC_KEY, lambda device: ContentEncoder(None, device, False), "rvc")
    st2.models.register(RMVPE_KEY, lambda device: F0Extractor(None, device, False), "rvc")
    c2 = TestClient(create_app(st2))
    c2.headers["Authorization"] = f"Bearer {TOKEN}"
    restored = c2.get(f"/jobs/{job_id}").json()
    assert restored["status"] == "paused" and restored["progress"] > 0.3
    assert c2.post(f"/jobs/{job_id}/resume").status_code == 200
    done = wait_job(c2, job_id, timeout=900)
    assert done["status"] == "done", done["log"][-5:]
    assert any("Tiếp tục từ checkpoint" in x for x in done["log"])
    assert "sts" in next(x for x in c2.get("/voices").json() if x["id"] == v["id"])["capabilities"]
    st2.queue.shutdown()


def test_training_requires_gpu_and_models(client, state, monkeypatch, tmp_path):
    files = dataset_files(tmp_path)
    monkeypatch.delenv("EASYVOICE_ALLOW_CPU_TRAIN", raising=False)
    if state.device() == "cpu":
        r = start_train(client, files, 1)
        assert r.status_code == 409 and r.json()["code"] == "GPU_REQUIRED"
    monkeypatch.setenv("EASYVOICE_ALLOW_CPU_TRAIN", "1")
    r = start_train(client, files, 1)
    assert r.status_code == 424 and r.json()["code"] == "MODEL_MISSING"
    assert client.get("/voices").json() == []  # không tạo giọng rác khi bị từ chối


def test_slicing_and_reference_pick():
    from easyvoice_engine.services.preprocess import slice as slicing

    sr = 40000
    chunk = voice_like(sr, 10.0)
    segs = slicing.segments(chunk, sr)
    assert all(len(s) <= int(sr * 3.7) for s in segs) and len(segs) == 3
    assert max(float(np.abs(s).max()) for s in segs) <= 0.9 + 1e-6
    ref = slicing.pick_reference([voice_like(sr, 3.0), voice_like(sr, 8.0), voice_like(sr, 14.0)], sr)
    assert ref is not None and abs(len(ref) / sr - 8.0) < 0.01


def test_demucs_separator_loads_from_local_dir(tmp_path):
    """Demucs nạp từ thư mục model của app (không tự tải), tự tạo file mô tả htdemucs.yaml."""
    pytest.importorskip("demucs")
    from demucs.htdemucs import HTDemucs
    from demucs.states import serialize_model
    from omegaconf import OmegaConf

    from easyvoice_engine.services.preprocess.separate import Separator

    m = HTDemucs(sources=["drums", "bass", "other", "vocals"], samplerate=44100, segment=7.8)
    torch.save(serialize_model(m, OmegaConf.create({}), half=False), tmp_path / "955717e8.th")
    sep = Separator(tmp_path, "cpu")
    audio = (np.sin(np.arange(40000 * 2) / 40000 * 2 * np.pi * 220) * 0.3).astype(np.float32)
    vocals, acc = sep.separate(audio, 40000)
    assert vocals.shape == acc.shape == audio.shape and np.isfinite(vocals).all()
    assert (tmp_path / "htdemucs.yaml").exists()
