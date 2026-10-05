"""Bọc F5-TTS (spec: chỉ dùng checkpoint có sẵn, không train F5). App gọi qua interface TtsBackend để có thể
thay model khác cho bản trả phí (ADR-0001) và để test không cần GPU/model."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol

import numpy as np

from ...core.errors import EngineError

log = logging.getLogger(__name__)


class TtsBackend(Protocol):
    sample_rate: int

    def synthesize(self, text: str, ref_audio: Path, ref_text: str, speed: float, seed: int) -> np.ndarray: ...


class F5Backend:
    """arch: cấu hình kiến trúc của checkpoint (F5TTS_v1_Base cho bản gốc, F5TTS_Base cho nhiều bản fine-tune cũ)."""

    def __init__(self, device: str, ckpt: Path, vocab: Path | None, arch: str, vocoder_dir: Path, nfe_step: int = 32,
                 lowercase: bool = False) -> None:
        try:
            from f5_tts.api import F5TTS
        except ImportError as exc:
            raise EngineError("MODEL_MISSING", f"f5-tts chưa được cài: {exc}") from exc
        for p in (ckpt, vocoder_dir / "config.yaml", vocoder_dir / "pytorch_model.bin"):
            if not p.exists():
                raise EngineError("MODEL_MISSING", str(p))
        self.nfe_step = nfe_step
        self.lowercase = lowercase
        self._tts = F5TTS(model=arch, ckpt_file=str(ckpt), vocab_file=str(vocab) if vocab else "",
                          vocoder_local_path=str(vocoder_dir), device=device)
        self.sample_rate = int(self._tts.target_sample_rate)

    def synthesize(self, text: str, ref_audio: Path, ref_text: str, speed: float, seed: int) -> np.ndarray:
        if self.lowercase:
            text, ref_text = text.lower(), ref_text.lower()
        wav, _sr, _spec = self._tts.infer(
            str(ref_audio), ref_text, text, speed=speed, seed=seed, nfe_step=self.nfe_step, show_info=lambda *a: None,
        )
        return np.asarray(wav, dtype=np.float32)

    def edit(self, audio: np.ndarray, text: str, start: float, end: float, new_duration: float, seed: int) -> np.ndarray:
        """Sửa lời một đoạn (speech editing của F5-TTS, như f5_tts/infer/speech_edit.py): audio 24 kHz chứa ngữ cảnh,
        text = lời thoại MỚI của cả đoạn. Vùng [start, end] (giây) bị che và sinh lại dài new_duration theo đúng
        giọng xung quanh; phần còn lại giữ nguyên mel gốc. Trả audio 24 kHz của cả đoạn sau khi sửa."""
        import torch
        from f5_tts.model.utils import convert_char_to_pinyin

        if self.lowercase:
            text = text.lower()
        tts = self._tts
        model = tts.ema_model
        hop = model.mel_spec.hop_length
        sr = self.sample_rate
        target_rms = 0.1
        x = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).unsqueeze(0)
        rms = float(x.pow(2).mean().sqrt())
        if 0 < rms < target_rms:
            x = x * target_rms / rms
        x = x.to(tts.device)
        with torch.inference_mode():
            mel = model.mel_spec(x).permute(0, 2, 1)
            s_f = min(mel.shape[1], round(start * sr / hop))
            e_f = min(mel.shape[1], max(s_f, round(end * sr / hop)))
            d_f = max(1, round(new_duration * sr / hop))
            zeros = torch.zeros(1, d_f, mel.shape[-1], device=mel.device, dtype=mel.dtype)
            cond = torch.cat([mel[:, :s_f], zeros, mel[:, e_f:]], dim=1)
            keep_after = cond.shape[1] - s_f - d_f
            mask = torch.cat([torch.ones(1, s_f, dtype=torch.bool), torch.zeros(1, d_f, dtype=torch.bool),
                              torch.ones(1, keep_after, dtype=torch.bool)], dim=-1).to(mel.device)
            gen, _ = model.sample(cond=cond, text=convert_char_to_pinyin([text]), duration=cond.shape[1],
                                  steps=self.nfe_step, cfg_strength=2.0, sway_sampling_coef=-1.0, seed=seed, edit_mask=mask)
            gen = gen.to(torch.float32).permute(0, 2, 1)
            wave = tts.vocoder.decode(gen) if tts.mel_spec_type == "vocos" else tts.vocoder(gen)
        y = wave.squeeze().float().cpu().numpy()
        if 0 < rms < target_rms:
            y = y * (rms / target_rms)
        return y.astype(np.float32)


def ema_safetensors(pt: Path) -> Path:
    """Checkpoint huấn luyện .pt (kèm optimizer, vài GB) → chỉ trọng số EMA dạng safetensors, chuyển một lần.
    Đỡ nạp cả optimizer lên GPU mỗi lần load; weights_only=True nên không chạy mã pickle tùy ý."""
    out = pt.with_suffix(".ema.safetensors")
    if out.exists() and out.stat().st_mtime >= pt.stat().st_mtime:
        return out
    import torch
    from safetensors.torch import save_file

    log.info("chuyển %s → %s (chỉ giữ trọng số EMA)", pt.name, out.name)
    ckpt = torch.load(str(pt), map_location="cpu", weights_only=True)
    state = ckpt.get("ema_model_state_dict") if isinstance(ckpt, dict) else None
    if state is None:
        raise EngineError("BAD_FILE", f"{pt.name}: không có ema_model_state_dict")
    tmp = out.with_suffix(".tmp")
    save_file({k: v.contiguous() for k, v in state.items() if isinstance(v, torch.Tensor)}, str(tmp))
    tmp.replace(out)
    return out
