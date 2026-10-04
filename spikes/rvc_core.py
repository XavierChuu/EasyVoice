"""Pipeline RVC v2 tối giản cho spike Phase 0 (offline + real-time dùng chung).

Luồng: audio 16 kHz → ContentVec/HuBERT (768-d, layer cuối) → (tùy chọn) trộn với faiss index
→ nội suy x2 lên khung 10 ms → F0 bằng RMVPE (+ pitch shift) → synthesizer RVC → audio ở sample rate của model.

Dựa trên modules/vc/pipeline.py và tools/rvc_for_realtime.py của RVC-Project, viết lại gọn để đo hiệu năng.
Chỉ hỗ trợ model RVC v2 (spec chỉ dùng v2).

Điểm Phase 0 cần kiểm chứng: encoder ContentVec dạng `transformers` (vd. lengyue233/content-vec-best) cho
đặc trưng tương đương `hubert_base.pt` (fairseq) mà RVC gốc dùng — so sánh tai nghe với output của RVC WebUI.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

import common  # noqa: F401  (thêm engine/third_party vào sys.path)
from rvc.models import SynthesizerTrnMs768NSFsid, SynthesizerTrnMs768NSFsid_nono
from rvc.rmvpe import RMVPE

SR_16K = 16000
HOP_16K = 160  # 10 ms ở 16 kHz — một khung F0 / khung synthesizer
F0_MIN, F0_MAX = 50.0, 1100.0
F0_MEL_MIN = 1127 * np.log(1 + F0_MIN / 700)
F0_MEL_MAX = 1127 * np.log(1 + F0_MAX / 700)

# Cấu hình chuẩn của RVC v2 (dùng khi chạy --dummy, không có checkpoint).
V2_CONFIGS: dict[int, list] = {
    40000: [1025, 32, 192, 192, 768, 2, 6, 3, 0, "1", [3, 7, 11], [[1, 3, 5]] * 3,
            [10, 10, 2, 2], 512, [16, 16, 4, 4], 109, 256, 40000],
    48000: [1025, 32, 192, 192, 768, 2, 6, 3, 0, "1", [3, 7, 11], [[1, 3, 5]] * 3,
            [12, 10, 2, 2], 512, [24, 20, 4, 4], 109, 256, 48000],
}


def f0_to_coarse(f0: np.ndarray) -> np.ndarray:
    f0_mel = 1127 * np.log(1 + f0 / 700)
    voiced = f0_mel > 0
    f0_mel[voiced] = (f0_mel[voiced] - F0_MEL_MIN) * 254 / (F0_MEL_MAX - F0_MEL_MIN) + 1
    f0_mel[f0_mel <= 1] = 1
    f0_mel[f0_mel > 255] = 255
    return np.rint(f0_mel).astype(np.int64)


@dataclass
class ConvertParams:
    pitch_shift: float = 0.0  # bán cung
    index_rate: float = 0.5
    protect: float = 0.33  # < 0.5 thì giữ phụ âm vô thanh khỏi bị index "làm méo"


class ContentEncoder:
    """ContentVec/HuBERT base qua transformers. Trả đặc trưng 768-d, 50 khung/giây."""

    def __init__(self, model_dir: str | Path | None, device: str, half: bool):
        from transformers import HubertConfig, HubertModel

        if model_dir is None:  # --dummy: khởi tạo ngẫu nhiên, chỉ để test đường code
            model = HubertModel(HubertConfig())
        else:
            model = HubertModel.from_pretrained(str(model_dir))
        model = model.eval().to(device)
        self.model = model.half() if half else model.float()
        self.device = device
        self.half = half

    @torch.no_grad()
    def __call__(self, audio16k: torch.Tensor) -> torch.Tensor:
        x = audio16k.view(1, -1).to(self.device)
        x = x.half() if self.half else x.float()
        return self.model(x).last_hidden_state  # [1, T, 768]


class Index:
    """faiss index của profile: thay một phần đặc trưng bằng đặc trưng gần nhất của giọng đích."""

    def __init__(self, path: str | Path):
        import faiss

        self.index = faiss.read_index(str(path))
        self.big_npy = self.index.reconstruct_n(0, self.index.ntotal)

    def blend(self, feats: torch.Tensor, rate: float) -> torch.Tensor:
        npy = feats[0].float().cpu().numpy()
        score, ix = self.index.search(npy, k=8)
        weight = np.square(1 / np.maximum(score, 1e-9))
        weight /= weight.sum(axis=1, keepdims=True)
        retrieved = np.sum(self.big_npy[ix] * np.expand_dims(weight, axis=2), axis=1)
        retrieved_t = torch.from_numpy(retrieved).unsqueeze(0).to(feats.device, feats.dtype)
        return retrieved_t * rate + (1 - rate) * feats


class RVCConverter:
    def __init__(
        self,
        model_path: str | Path | None,
        hubert_dir: str | Path | None,
        rmvpe_path: str | Path | None,
        index_path: str | Path | None,
        device: str,
        half: bool,
        dummy_sr: int = 40000,
    ):
        self.device = device
        self.half = half
        self.net_g, self.tgt_sr, self.if_f0 = self._load_synth(model_path, dummy_sr)
        self.tgt_hop = self.tgt_sr // 100
        self.encoder = ContentEncoder(hubert_dir, device, half)
        self.rmvpe = RMVPE(str(rmvpe_path) if rmvpe_path else None, is_half=half, device=device)
        self.index = Index(index_path) if index_path else None
        self.sid = torch.tensor([0], device=device).long()

    def _load_synth(self, model_path, dummy_sr):
        if model_path is None:
            config = list(V2_CONFIGS[dummy_sr])
            weight, if_f0 = None, 1
        else:
            # .pth của RVC là dict (weight/config/f0/version...) — weights_only=True chặn pickle chứa code.
            cpt = torch.load(str(model_path), map_location="cpu", weights_only=True)
            if cpt.get("version", "v1") != "v2":
                raise ValueError(f"Chỉ hỗ trợ RVC v2, model này là {cpt.get('version', 'v1')}")
            config = list(cpt["config"])
            config[-3] = cpt["weight"]["emb_g.weight"].shape[0]
            weight, if_f0 = cpt["weight"], cpt.get("f0", 1)
        cls = SynthesizerTrnMs768NSFsid if if_f0 == 1 else SynthesizerTrnMs768NSFsid_nono
        net_g = cls(*config, is_half=self.half)
        del net_g.enc_q
        if weight is not None:
            net_g.load_state_dict(weight, strict=False)
        net_g = net_g.eval().to(self.device)
        net_g = net_g.half() if self.half else net_g.float()
        return net_g, int(config[-1]), if_f0

    @torch.no_grad()
    def convert(
        self,
        audio16k: np.ndarray,
        params: ConvertParams,
        return_frames: int | None = None,
    ) -> np.ndarray:
        """Đổi giọng một đoạn audio 16 kHz.

        return_frames: chỉ giải mã N khung 10 ms cuối (real-time: phần đầu buffer chỉ làm ngữ cảnh).
        Trả về float32 ở self.tgt_sr, dài p_len * tgt_hop (hoặc return_frames * tgt_hop).
        """
        p_len = len(audio16k) // HOP_16K
        x = torch.from_numpy(audio16k).to(self.device)

        feats = self.encoder(x)
        if self.index is not None and params.index_rate > 0:
            feats0 = feats.clone()
            feats = self.index.blend(feats, params.index_rate)
        else:
            feats0 = feats
        feats = F.interpolate(feats.permute(0, 2, 1), scale_factor=2).permute(0, 2, 1)
        feats0 = F.interpolate(feats0.permute(0, 2, 1), scale_factor=2).permute(0, 2, 1)
        # HuBERT thiếu 1-2 khung ở cuối so với p_len: lặp khung cuối (như rvc_for_realtime.py).
        if feats.shape[1] < p_len:
            pad = p_len - feats.shape[1]
            feats = torch.cat([feats, feats[:, -1:].expand(-1, pad, -1)], dim=1)
            feats0 = torch.cat([feats0, feats0[:, -1:].expand(-1, pad, -1)], dim=1)
        feats, feats0 = feats[:, :p_len], feats0[:, :p_len]

        pitch = pitchf = None
        if self.if_f0 == 1:
            f0 = self.rmvpe.infer_from_audio(x.float(), thred=0.03)[:p_len]
            if len(f0) < p_len:
                f0 = np.pad(f0, (0, p_len - len(f0)))
            f0 = f0 * pow(2, params.pitch_shift / 12)
            pitch = torch.from_numpy(f0_to_coarse(f0.copy())).unsqueeze(0).to(self.device)
            pitchf = torch.from_numpy(f0.astype(np.float32)).unsqueeze(0).to(self.device)
            if params.protect < 0.5:
                mask = torch.where(pitchf > 0, 1.0, params.protect).unsqueeze(-1).to(feats.dtype)
                feats = feats * mask + feats0 * (1 - mask)

        lengths = torch.tensor([p_len], device=self.device).long()
        net = self.net_g
        g = net.emb_g(self.sid).unsqueeze(-1)
        m_p, logs_p, x_mask = net.enc_p(feats, pitch, lengths)
        z_p = (m_p + torch.exp(logs_p) * torch.randn_like(m_p) * 0.66666) * x_mask
        if return_frames is not None and return_frames < p_len:
            z_p, x_mask = z_p[:, :, -return_frames:], x_mask[:, :, -return_frames:]
            if pitchf is not None:
                pitchf = pitchf[:, -return_frames:]
        z = net.flow(z_p, x_mask, g=g, reverse=True)
        if self.if_f0 == 1:
            o = net.dec(z * x_mask, pitchf, g=g)
        else:
            o = net.dec(z * x_mask, g=g)
        return o[0, 0].float().cpu().numpy()
