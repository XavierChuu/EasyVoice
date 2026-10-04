"""Tích hợp thật với thư viện f5-tts, dùng checkpoint + vocoder KHỞI TẠO NGẪU NHIÊN (không cần tải model).
Kiểm tra wrapper gọi đúng API f5-tts và job TTS chạy hết đường code. Chậm (~1 phút CPU) nên chỉ chạy khi
EASYVOICE_SLOW=1 và đã cài f5-tts."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("EASYVOICE_SLOW") != "1", reason="set EASYVOICE_SLOW=1")

VOCOS_CONFIG = """feature_extractor:
  class_path: vocos.feature_extractors.MelSpectrogramFeatures
  init_args: {sample_rate: 24000, n_fft: 1024, hop_length: 256, n_mels: 100, padding: center}
backbone:
  class_path: vocos.models.VocosBackbone
  init_args: {input_channels: 100, dim: 512, intermediate_dim: 1536, num_layers: 8}
head:
  class_path: vocos.heads.ISTFTHead
  init_args: {dim: 512, n_fft: 1024, hop_length: 256, padding: center}
"""


def make_random_f5(models: Path) -> None:
    import torch
    from importlib.resources import files

    from hydra.utils import get_class
    from omegaconf import OmegaConf
    from safetensors.torch import save_file
    from vocos import Vocos

    from f5_tts.infer.utils_infer import get_tokenizer
    from f5_tts.model import CFM

    voc = models / "vocos-mel-24khz"
    voc.mkdir(parents=True)
    (voc / "config.yaml").write_text(VOCOS_CONFIG)
    torch.save(Vocos.from_hparams(str(voc / "config.yaml")).state_dict(), voc / "pytorch_model.bin")

    cfg = OmegaConf.load(str(files("f5_tts").joinpath("configs/F5TTS_v1_Base.yaml")))
    _, vocab_size = get_tokenizer(str(files("f5_tts").joinpath("infer/examples/vocab.txt")), "custom")
    mel = cfg.model.mel_spec
    model = CFM(
        transformer=get_class(f"f5_tts.model.{cfg.model.backbone}")(**cfg.model.arch, text_num_embeds=vocab_size, mel_dim=mel.n_mel_channels),
        mel_spec_kwargs=dict(n_fft=mel.n_fft, hop_length=mel.hop_length, win_length=mel.win_length,
                             n_mel_channels=mel.n_mel_channels, target_sample_rate=mel.target_sample_rate, mel_spec_type="vocos"),
    )
    d = models / "f5tts-v1-base"
    d.mkdir(parents=True)
    sd = {k: v.contiguous() for k, v in model.state_dict().items()}
    save_file(sd, str(d / "model_1250000.safetensors"))


def test_f5_backend_through_api(tmp_path, monkeypatch, wav_file):
    pytest.importorskip("f5_tts")
    from fastapi.testclient import TestClient

    from conftest import TOKEN, wait_job
    from easyvoice_engine.core.state import EngineState
    from easyvoice_engine.main import create_app

    state = EngineState.create(TOKEN, tmp_path / "data")
    make_random_f5(state.paths.models)
    client = TestClient(create_app(state))
    client.headers["Authorization"] = f"Bearer {TOKEN}"
    with wav_file.open("rb") as f:
        v = client.post("/voices", data={"name": "EN", "language": "en", "transcript": "Some call me nature.",
                                         "consent": "true"}, files={"file": ("ref.wav", f)}).json()
    job_id = client.post("/tts", json={"profileId": v["id"], "text": "Hello world.", "seed": 3}).json()["jobId"]
    job = wait_job(client, job_id, timeout=600)
    assert job["status"] == "done", job
    assert job["outputDurationSec"] > 0.3
    assert "tts" in state.models.loaded()
    state.queue.shutdown()
