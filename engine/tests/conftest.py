from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from easyvoice_engine.core.state import EngineState
from easyvoice_engine.main import create_app
from easyvoice_engine.services.registry import CONTENTVEC_KEY, RMVPE_KEY, TTS_KEY

TOKEN = "test-token"


class FakeTts:
    """Thay F5-TTS trong test: sinh sóng sin, độ dài theo số ký tự."""

    sample_rate = 24000

    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str]] = []

    def synthesize(self, text, ref_audio, ref_text, speed, seed):
        assert Path(ref_audio).exists() and ref_text
        self.calls.append((text, seed, str(ref_audio)))
        n = int(self.sample_rate * max(0.3, len(text) * 0.03) / speed)
        t = np.arange(n) / self.sample_rate
        return (0.3 * np.sin(2 * np.pi * (180 + seed % 50) * t)).astype(np.float32)


def voice_like(sr: int, seconds: float) -> np.ndarray:
    t = np.arange(int(sr * seconds)) / sr
    f0 = 140 + 30 * np.sin(2 * np.pi * 0.5 * t)
    ph = 2 * np.pi * np.cumsum(f0) / sr
    env = (0.6 + 0.4 * np.sin(2 * np.pi * 1.3 * t)) * (np.sin(2 * np.pi * 0.7 * t) > -0.3)  # có khoảng nghỉ như giọng thật
    return (sum(np.sin(k * ph) / k for k in range(1, 6)) * 0.2 * env).astype(np.float32)


@pytest.fixture
def wav_file(tmp_path) -> Path:
    p = tmp_path / "ref.wav"
    sf.write(p, voice_like(44100, 6.0), 44100)
    return p


@pytest.fixture
def state(tmp_path, monkeypatch) -> EngineState:
    monkeypatch.setenv("EASYVOICE_DATA_DIR", str(tmp_path / "data"))
    st = EngineState.create(TOKEN, tmp_path / "data")
    fake = FakeTts()
    st.extras["fake_tts"] = fake
    st.models.register(TTS_KEY, lambda device: fake, "tts")
    yield st
    st.queue.shutdown()


@pytest.fixture
def dummy_rvc_assets(state):
    """Encoder ContentVec + RMVPE khởi tạo ngẫu nhiên (không cần tải model) để chạy đủ đường code STS trên CPU."""
    from easyvoice_engine.services.rvc.infer import ContentEncoder, F0Extractor

    state.models.register(CONTENTVEC_KEY, lambda device: ContentEncoder(None, device, False), "rvc")
    state.models.register(RMVPE_KEY, lambda device: F0Extractor(None, device, False), "rvc")
    return state


@pytest.fixture
def client(state) -> TestClient:
    c = TestClient(create_app(state))
    c.headers["Authorization"] = f"Bearer {TOKEN}"
    return c


def wait_job(client: TestClient, job_id: str, timeout: float = 120, until=("done", "failed", "cancelled", "paused")) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        job = client.get(f"/jobs/{job_id}").json()
        if job["status"] in until:
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} timeout: {job}")


def make_rvc_pth(path: Path, sr: int = 40000) -> Path:
    import torch

    from easyvoice_engine.services.rvc import THIRD_PARTY  # noqa: F401
    from rvc.models import SynthesizerTrnMs768NSFsid

    cfg = [1025, 32, 192, 192, 768, 2, 6, 3, 0, "1", [3, 7, 11], [[1, 3, 5]] * 3,
           [10, 10, 2, 2], 512, [16, 16, 4, 4], 109, 256, sr]
    net = SynthesizerTrnMs768NSFsid(*cfg, is_half=False)
    torch.save({"weight": net.state_dict(), "config": cfg, "f0": 1, "version": "v2", "info": "test", "sr": "40k"}, path)
    return path
