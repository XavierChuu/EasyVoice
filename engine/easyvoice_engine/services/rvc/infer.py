"""Đổi giọng RVC v2 (offline). Luồng: audio 16 kHz → ContentVec (768-d) → trộn faiss index → nội suy x2 →
F0 RMVPE (+pitch shift) → synthesizer → audio ở sample rate của model. Dựa trên pipeline của RVC-Project."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import THIRD_PARTY  # noqa: F401  (đảm bảo import được rvc.*)

SR_16K = 16000
HOP_16K = 160
F0_MIN, F0_MAX = 50.0, 1100.0
F0_MEL_MIN = 1127 * np.log(1 + F0_MIN / 700)
F0_MEL_MAX = 1127 * np.log(1 + F0_MAX / 700)


def f0_to_coarse(f0: np.ndarray) -> np.ndarray:
    mel = 1127 * np.log(1 + f0 / 700)
    voiced = mel > 0
    mel[voiced] = (mel[voiced] - F0_MEL_MIN) * 254 / (F0_MEL_MAX - F0_MEL_MIN) + 1
    mel[mel <= 1] = 1
    mel[mel > 255] = 255
    return np.rint(mel).astype(np.int64)


@dataclass
class ConvertParams:
    pitch_shift: float = 0.0
    index_rate: float = 0.5
    protect: float = 0.33


class ContentEncoder:
    def __init__(self, model_dir: Path | None, device: str, half: bool) -> None:
        from transformers import HubertConfig, HubertModel

        model = HubertModel(HubertConfig()) if model_dir is None else HubertModel.from_pretrained(str(model_dir))
        model = model.eval().to(device)
        self.model = model.half() if half else model.float()
        self.device, self.half = device, half

    def __call__(self, audio16k):
        import torch

        with torch.no_grad():
            x = audio16k.view(1, -1).to(self.device)
            x = x.half() if self.half else x.float()
            return self.model(x).last_hidden_state


class F0Extractor:
    def __init__(self, model_path: Path | None, device: str, half: bool) -> None:
        from rvc.rmvpe import RMVPE

        self.rmvpe = RMVPE(str(model_path) if model_path else None, is_half=half, device=device)

    def __call__(self, audio16k) -> np.ndarray:
        return self.rmvpe.infer_from_audio(audio16k, thred=0.03)


class RvcModel:
    """Synthesizer RVC v2 nạp từ model.safetensors + cấu hình trong profile (không dùng .pth — ADR-0001)."""

    def __init__(self, weights: dict | None, config: list, f0: int, device: str, half: bool) -> None:
        import torch
        from rvc.models import SynthesizerTrnMs768NSFsid, SynthesizerTrnMs768NSFsid_nono

        cls = SynthesizerTrnMs768NSFsid if f0 == 1 else SynthesizerTrnMs768NSFsid_nono
        net = cls(*config, is_half=half)
        del net.enc_q
        if weights is not None:
            net.load_state_dict(weights, strict=False)
        net = net.eval().to(device)
        self.net = net.half() if half else net.float()
        self.sr = int(config[-1])
        self.hop = self.sr // 100
        self.f0 = f0
        self.device, self.half = device, half
        self.sid = torch.tensor([0], device=device).long()

    @classmethod
    def from_files(cls, weights_path: Path, meta_path: Path, device: str, half: bool) -> "RvcModel":
        from safetensors.torch import load_file

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return cls(load_file(str(weights_path)), meta["config"], int(meta.get("f0", 1)), device, half)


class Index:
    def __init__(self, path: Path) -> None:
        import faiss

        self.index = faiss.read_index(str(path))
        self.big_npy = self.index.reconstruct_n(0, self.index.ntotal)

    def blend(self, feats, rate: float):
        import torch

        npy = feats[0].float().cpu().numpy()
        score, ix = self.index.search(npy, k=8)
        weight = np.square(1 / np.maximum(score, 1e-9))
        weight /= weight.sum(axis=1, keepdims=True)
        retrieved = np.sum(self.big_npy[ix] * np.expand_dims(weight, axis=2), axis=1)
        return torch.from_numpy(retrieved).unsqueeze(0).to(feats.device, feats.dtype) * rate + (1 - rate) * feats


def convert(model: RvcModel, encoder: ContentEncoder, f0x: F0Extractor, index: Index | None,
            audio16k: np.ndarray, params: ConvertParams, return_frames: int | None = None) -> np.ndarray:
    import torch
    import torch.nn.functional as F

    with torch.no_grad():
        p_len = len(audio16k) // HOP_16K
        x = torch.from_numpy(audio16k).to(model.device)
        feats = encoder(x)
        feats0 = feats
        if index is not None and params.index_rate > 0:
            feats0 = feats.clone()
            feats = index.blend(feats, params.index_rate)
        feats = F.interpolate(feats.permute(0, 2, 1), scale_factor=2).permute(0, 2, 1)
        feats0 = F.interpolate(feats0.permute(0, 2, 1), scale_factor=2).permute(0, 2, 1)
        if feats.shape[1] < p_len:  # HuBERT hụt 1-2 khung cuối: lặp khung cuối
            pad = p_len - feats.shape[1]
            feats = torch.cat([feats, feats[:, -1:].expand(-1, pad, -1)], dim=1)
            feats0 = torch.cat([feats0, feats0[:, -1:].expand(-1, pad, -1)], dim=1)
        # Encoder/index có thể trả float32 trong khi synthesizer chạy half trên GPU (như RVC gốc: feats theo dtype
        # của net, pitchf giữ float32).
        dtype = next(model.net.parameters()).dtype
        feats, feats0 = feats[:, :p_len].to(dtype), feats0[:, :p_len].to(dtype)
        pitch = pitchf = None
        if model.f0 == 1:
            f0 = f0x(x.float())[:p_len]
            if len(f0) < p_len:
                f0 = np.pad(f0, (0, p_len - len(f0)))
            f0 = f0 * pow(2, params.pitch_shift / 12)
            pitch = torch.from_numpy(f0_to_coarse(f0.copy())).unsqueeze(0).to(model.device)
            pitchf = torch.from_numpy(f0.astype(np.float32)).unsqueeze(0).to(model.device)
            if params.protect < 0.5:
                mask = torch.where(pitchf > 0, 1.0, params.protect).unsqueeze(-1).to(feats.dtype)
                feats = feats * mask + feats0 * (1 - mask)
        net = model.net
        lengths = torch.tensor([p_len], device=model.device).long()
        g = net.emb_g(model.sid).unsqueeze(-1)
        m_p, logs_p, x_mask = net.enc_p(feats, pitch, lengths)
        z_p = (m_p + torch.exp(logs_p) * torch.randn_like(m_p) * 0.66666) * x_mask
        if return_frames is not None and return_frames < p_len:
            z_p, x_mask = z_p[:, :, -return_frames:], x_mask[:, :, -return_frames:]
            if pitchf is not None:
                pitchf = pitchf[:, -return_frames:]
        z = net.flow(z_p, x_mask, g=g, reverse=True)
        o = net.dec(z * x_mask, pitchf, g=g) if model.f0 == 1 else net.dec(z * x_mask, g=g)
        return o[0, 0].float().cpu().numpy()


def convert_long(model: RvcModel, encoder: ContentEncoder, f0x: F0Extractor, index: Index | None,
                 audio16k: np.ndarray, params: ConvertParams, chunk_sec: float = 30.0, pad_sec: float = 1.0,
                 xfade_sec: float = 0.05, on_progress=None) -> np.ndarray:
    """File dài: chia đoạn có ngữ cảnh hai bên, ghép crossfade để không có tiếng click (spec 3.3)."""
    def frames(sec: float) -> int:
        return max(1, round(sec * SR_16K / HOP_16K))

    chunk, pad, xf = frames(chunk_sec) * HOP_16K, frames(pad_sec) * HOP_16K, frames(xfade_sec) * HOP_16K
    n = len(audio16k)
    need = pad + xf + chunk
    padded = np.pad(audio16k, (pad, need), mode="reflect" if n > need else "constant")
    ratio = model.hop / HOP_16K
    xf_t = round(xf * ratio)
    fade_in = np.sin(0.5 * np.pi * np.linspace(0, 1, xf_t, dtype=np.float32)) ** 2
    out: list[np.ndarray] = []
    tail: np.ndarray | None = None
    starts = list(range(0, n, chunk))
    for k, start in enumerate(starts):
        y = convert(model, encoder, f0x, index, padded[start: start + pad + chunk + xf + pad], params)
        piece = y[round(pad * ratio): round((pad + chunk + xf) * ratio)]
        want = round((chunk + xf) * ratio)
        if len(piece) < want:
            piece = np.pad(piece, (0, want - len(piece)))
        if tail is not None:
            piece[:xf_t] = piece[:xf_t] * fade_in + tail * (1 - fade_in)
        out.append(piece[:-xf_t])
        tail = piece[-xf_t:]
        if on_progress:
            on_progress((k + 1) / len(starts))
    return np.concatenate(out)[: round(n * ratio)] if out else np.zeros(0, dtype=np.float32)
