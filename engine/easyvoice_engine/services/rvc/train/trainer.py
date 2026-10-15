"""Vòng lặp huấn luyện RVC v2 (GAN kiểu VITS): mel L1 ×45 + KL + feature matching + adversarial, discriminator
đa chu kỳ. Khởi tạo từ pretrained f0G/f0D của RVC. Lưu checkpoint định kỳ và khi bị hủy → tiếp tục được."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn.functional as F

from ....core.device import fp16_ok
from .. import THIRD_PARTY  # noqa: F401
from .config import TrainConfig
from .data import TrainDataset, collate, list_items

log = logging.getLogger(__name__)


@dataclass
class TrainNets:
    net_g: torch.nn.Module
    net_d: torch.nn.Module


def build_nets(cfg: TrainConfig, device: str) -> TrainNets:
    from rvc.models import MultiPeriodDiscriminatorV2, SynthesizerTrnMs768NSFsid

    net_g = SynthesizerTrnMs768NSFsid(*cfg.synth_config(), is_half=False).to(device)
    net_d = MultiPeriodDiscriminatorV2(use_spectral_norm=False).to(device)
    return TrainNets(net_g, net_d)


def load_pretrained(nets: TrainNets, g_path: Path, d_path: Path) -> None:
    for net, path in ((nets.net_g, g_path), (nets.net_d, d_path)):
        ckpt = torch.load(str(path), map_location="cpu", weights_only=True)
        state = ckpt.get("model", ckpt) if isinstance(ckpt, dict) else ckpt
        missing, _ = net.load_state_dict(state, strict=False)
        if missing:
            log.warning("pretrained %s thiếu %d tham số", path.name, len(missing))


def _atomic_save(obj: dict, path: Path) -> None:
    tmp = path.with_suffix(".tmp")
    torch.save(obj, tmp)
    tmp.replace(path)


@dataclass
class Progress:
    epoch: int  # epoch đang chạy (1-based)
    total_epochs: int
    step_in_epoch: int
    steps_per_epoch: int
    loss_mel: float | None = None

    @property
    def fraction(self) -> float:
        done = (self.epoch - 1) + self.step_in_epoch / max(1, self.steps_per_epoch)
        return min(1.0, done / self.total_epochs)


def train(nets: TrainNets, cfg: TrainConfig, data_dir: Path, ckpt_dir: Path, total_epochs: int, device: str,
          on_progress: Callable[[Progress], None], on_log: Callable[[str], None], check_cancel: Callable[[], None],
          save_every: int = 5, seed: int = 1234, on_checkpoint: Callable[[int], None] | None = None) -> int:
    """Trả về số epoch đã hoàn thành. check_cancel ném exception khi người dùng hủy — checkpoint được lưu trước đó."""
    from rvc import commons
    from rvc.losses import discriminator_loss, feature_loss, generator_loss, kl_loss
    from rvc.mel_processing import mel_spectrogram_torch, spec_to_mel_torch

    torch.manual_seed(seed)
    items = list_items(data_dir)
    if not items:
        raise RuntimeError("dataset trống")
    loader = torch.utils.data.DataLoader(TrainDataset(items, cfg), batch_size=min(cfg.batch_size, len(items)),
                                         shuffle=True, collate_fn=collate, num_workers=0, drop_last=False)
    net_g, net_d = nets.net_g, nets.net_d
    opt_g = torch.optim.AdamW(net_g.parameters(), cfg.learning_rate, betas=cfg.betas, eps=cfg.eps)
    opt_d = torch.optim.AdamW(net_d.parameters(), cfg.learning_rate, betas=cfg.betas, eps=cfg.eps)
    sched_g = torch.optim.lr_scheduler.ExponentialLR(opt_g, gamma=cfg.lr_decay)
    sched_d = torch.optim.lr_scheduler.ExponentialLR(opt_d, gamma=cfg.lr_decay)
    use_amp = fp16_ok(device)
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    ckpt_path = ckpt_dir / "latest.pt"
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    done_epochs = 0
    if ckpt_path.exists():  # tiếp tục từ checkpoint
        ck = torch.load(str(ckpt_path), map_location="cpu", weights_only=True)
        net_g.load_state_dict(ck["g"])
        net_d.load_state_dict(ck["d"])
        opt_g.load_state_dict(ck["opt_g"])
        opt_d.load_state_dict(ck["opt_d"])
        sched_g.load_state_dict(ck["sched_g"])
        sched_d.load_state_dict(ck["sched_d"])
        if use_amp and "scaler" in ck:
            scaler.load_state_dict(ck["scaler"])
        done_epochs = int(ck["epoch"])
        on_log(f"Tiếp tục từ checkpoint · epoch {done_epochs}/{total_epochs}")

    def save(epoch_done: int) -> None:
        _atomic_save({"g": net_g.state_dict(), "d": net_d.state_dict(), "opt_g": opt_g.state_dict(),
                      "opt_d": opt_d.state_dict(), "sched_g": sched_g.state_dict(), "sched_d": sched_d.state_dict(),
                      "scaler": scaler.state_dict(), "epoch": epoch_done}, ckpt_path)
        if on_checkpoint:
            on_checkpoint(epoch_done)

    net_g.train()
    net_d.train()
    steps = len(loader)
    on_log(f"{len(items)} đoạn · batch {loader.batch_size} · {steps} bước/epoch · {device}{' · fp16' if use_amp else ''}")
    hop, seg_frames = cfg.hop_length, cfg.segment_size // cfg.hop_length
    t_epoch = time.time()
    epoch = done_epochs + 1
    try:
        for epoch in range(done_epochs + 1, total_epochs + 1):
            mel_sum = 0.0
            for step, batch in enumerate(loader, 1):
                check_cancel()
                phone, phone_len, pitch, pitchf, spec, spec_len, wav, _wav_len, sid = (x.to(device) for x in batch)
                with torch.autocast("cuda", enabled=use_amp):
                    y_hat, ids_slice, _x_mask, z_mask, (_z, z_p, m_p, logs_p, _m_q, logs_q) = net_g(
                        phone, phone_len, pitch, pitchf, spec, spec_len, sid)
                    mel = spec_to_mel_torch(spec, cfg.filter_length, cfg.n_mel_channels, cfg.sample_rate, cfg.mel_fmin, cfg.mel_fmax)
                    y_mel = commons.slice_segments(mel, ids_slice, seg_frames)
                    with torch.autocast("cuda", enabled=False):
                        y_hat_mel = mel_spectrogram_torch(y_hat.float().squeeze(1), cfg.filter_length, cfg.n_mel_channels,
                                                          cfg.sample_rate, hop, cfg.win_length, cfg.mel_fmin, cfg.mel_fmax)
                    wav_slice = commons.slice_segments(wav, ids_slice * hop, cfg.segment_size)
                    y_d_r, y_d_g, _, _ = net_d(wav_slice, y_hat.detach())
                    with torch.autocast("cuda", enabled=False):
                        loss_disc, _, _ = discriminator_loss(y_d_r, y_d_g)
                opt_d.zero_grad()
                scaler.scale(loss_disc).backward()
                scaler.unscale_(opt_d)
                scaler.step(opt_d)

                with torch.autocast("cuda", enabled=use_amp):
                    _, y_d_g, fmap_r, fmap_g = net_d(wav_slice, y_hat)
                    with torch.autocast("cuda", enabled=False):
                        loss_mel = F.l1_loss(y_mel.float(), y_hat_mel) * cfg.c_mel
                        loss_kl = kl_loss(z_p, logs_q, m_p, logs_p, z_mask) * cfg.c_kl
                        loss_fm = feature_loss(fmap_r, fmap_g)
                        loss_gen, _ = generator_loss(y_d_g)
                        loss_g = loss_gen + loss_fm + loss_mel + loss_kl
                opt_g.zero_grad()
                scaler.scale(loss_g).backward()
                scaler.unscale_(opt_g)
                scaler.step(opt_g)
                scaler.update()
                mel_sum += loss_mel.item()
                on_progress(Progress(epoch, total_epochs, step, steps, loss_mel.item()))
            sched_g.step()
            sched_d.step()
            if epoch % save_every == 0 or epoch == total_epochs:
                save(epoch)
            if epoch % max(1, save_every) == 0 or epoch == total_epochs or epoch == done_epochs + 1:
                on_log(f"epoch {epoch}/{total_epochs} · loss_mel {mel_sum / steps:.2f} · {time.time() - t_epoch:.1f}s/epoch"
                       + (" · checkpoint" if epoch % save_every == 0 or epoch == total_epochs else ""))
            t_epoch = time.time()
    except BaseException as exc:  # hủy (ở đầu bước hoặc trong callback tiến độ) hoặc lỗi: luôn giữ checkpoint
        save(epoch - 1)  # trọng số giữa epoch vẫn được giữ, epoch này sẽ chạy lại khi tiếp tục
        if type(exc).__name__ == "Cancelled":
            on_log(f"Đã tạm dừng · checkpoint giữ ở epoch {epoch - 1}")
        raise
    net_g.eval()
    return total_epochs


def export_generator(net_g: torch.nn.Module, cfg: TrainConfig, out_dir: Path) -> dict:
    """model.safetensors (fp16, bỏ posterior encoder enc_q như RVC) + rvc.json — cùng định dạng với model nhập."""
    import json

    from safetensors.torch import save_file

    weights = {k: v.detach().half().contiguous().cpu() for k, v in net_g.state_dict().items() if not k.startswith("enc_q")}
    save_file(weights, str(out_dir / "model.safetensors"))
    meta = {"config": cfg.synth_config(), "f0": 1, "version": "v2", "sr": cfg.sample_rate}
    (out_dir / "rvc.json").write_text(json.dumps(meta), encoding="utf-8")
    return meta
