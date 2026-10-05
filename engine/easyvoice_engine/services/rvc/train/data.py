"""Dataset huấn luyện: mỗi đoạn có wav gốc (40 kHz), đặc trưng ContentVec (768-d, 20 ms), F0 thô + F0 liên tục (10 ms)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from .. import THIRD_PARTY  # noqa: F401
from .config import TrainConfig


@dataclass
class Item:
    wav: Path
    feat: Path
    f0: Path
    f0nsf: Path


def list_items(root: Path) -> list[Item]:
    items = []
    for wav in sorted((root / "0_gt").glob("*.wav")):
        stem = wav.stem
        feat, f0, f0nsf = root / "3_feat" / f"{stem}.npy", root / "2_f0" / f"{stem}.npy", root / "2_f0nsf" / f"{stem}.npy"
        if feat.exists() and f0.exists() and f0nsf.exists():
            items.append(Item(wav, feat, f0, f0nsf))
    return items


class TrainDataset(torch.utils.data.Dataset):
    def __init__(self, items: list[Item], cfg: TrainConfig) -> None:
        self.items, self.cfg = items, cfg
        self._spec_cache: dict[int, torch.Tensor] = {}

    def __len__(self) -> int:
        return len(self.items)

    def _spec(self, i: int, wav: torch.Tensor) -> torch.Tensor:
        if i not in self._spec_cache:
            from rvc.mel_processing import spectrogram_torch

            c = self.cfg
            self._spec_cache[i] = spectrogram_torch(wav, c.filter_length, c.sample_rate, c.hop_length, c.win_length,
                                                    center=False).squeeze(0)
        return self._spec_cache[i]

    def __getitem__(self, i: int):
        import soundfile as sf

        it, c = self.items[i], self.cfg
        audio, _ = sf.read(str(it.wav), dtype="float32")
        wav = torch.from_numpy(audio).unsqueeze(0)
        spec = self._spec(i, wav)
        phone = np.repeat(np.load(it.feat), 2, axis=0)  # 20 ms → 10 ms
        pitch, pitchf = np.load(it.f0), np.load(it.f0nsf)
        n = min(phone.shape[0], spec.shape[-1], len(pitch), len(pitchf), c.max_frames)
        return (torch.from_numpy(phone[:n]).float(), torch.from_numpy(pitch[:n]).long(), torch.from_numpy(pitchf[:n]).float(),
                spec[:, :n], wav[:, : n * c.hop_length])


def collate(batch):
    batch = sorted(batch, key=lambda b: b[3].shape[-1], reverse=True)
    max_phone = max(b[0].shape[0] for b in batch)
    max_spec = max(b[3].shape[-1] for b in batch)
    max_wav = max(b[4].shape[-1] for b in batch)
    n = len(batch)
    phone = torch.zeros(n, max_phone, batch[0][0].shape[1])
    pitch = torch.zeros(n, max_phone, dtype=torch.long)
    pitchf = torch.zeros(n, max_phone)
    spec = torch.zeros(n, batch[0][3].shape[0], max_spec)
    wav = torch.zeros(n, 1, max_wav)
    phone_len, spec_len, wav_len = (torch.zeros(n, dtype=torch.long) for _ in range(3))
    for i, (ph, p, pf, sp, w) in enumerate(batch):
        phone[i, : ph.shape[0]], pitch[i, : p.shape[0]], pitchf[i, : pf.shape[0]] = ph, p, pf
        spec[i, :, : sp.shape[-1]], wav[i, :, : w.shape[-1]] = sp, w
        phone_len[i], spec_len[i], wav_len[i] = ph.shape[0], sp.shape[-1], w.shape[-1]
    sid = torch.zeros(n, dtype=torch.long)
    return phone, phone_len, pitch, pitchf, spec, spec_len, wav, wav_len, sid
