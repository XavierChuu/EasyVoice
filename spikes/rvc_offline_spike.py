"""Spike Phase 0 — RVC v2 đổi giọng offline (file → file) với F0 = RMVPE.

Đo: thời gian load, RTF (thời gian xử lý / thời lượng audio), bộ nhớ GPU đỉnh.
File dài được chia đoạn có chồng lấn rồi ghép crossfade (cách spec mục 3.3 dự định làm), để nghe kiểm tra tiếng click.

Ví dụ:
  python rvc_offline_spike.py --input samples/giong_noi.wav --model models/rvc/voice.pth \
      --index models/rvc/voice.index --hubert models/content-vec-best --rmvpe models/rmvpe.pt
  python rvc_offline_spike.py --dummy --input samples/giong_noi.wav    # chỉ test đường code, output là nhiễu
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

from common import (
    MODELS_DIR, OUT_DIR, Results, free_memory, load_audio, memory_snapshot, pick_device,
    reset_peak_memory, resample, timer,
)
from rvc_core import HOP_16K, SR_16K, ConvertParams, RVCConverter

_BH, _AH = signal.butter(N=5, Wn=48, btype="high", fs=SR_16K)  # lọc DC/rumble như RVC gốc


def convert_long(
    conv: RVCConverter,
    audio16k: np.ndarray,
    params: ConvertParams,
    chunk_sec: float,
    pad_sec: float,
    xfade_sec: float,
) -> np.ndarray:
    """Chia đoạn chunk_sec, mỗi đoạn kèm pad_sec ngữ cảnh hai bên, ghép bằng crossfade xfade_sec."""
    def frames(sec: float) -> int:
        return max(1, round(sec * SR_16K / HOP_16K))

    chunk, pad, xf = frames(chunk_sec) * HOP_16K, frames(pad_sec) * HOP_16K, frames(xfade_sec) * HOP_16K
    n = len(audio16k)
    padded = np.pad(audio16k, (pad, pad + xf + chunk), mode="reflect" if n > pad + xf + chunk else "constant")
    ratio = conv.tgt_hop / HOP_16K  # mẫu đích trên mỗi mẫu 16k
    xf_t = round(xf * ratio)
    fade_in = np.sin(0.5 * np.pi * np.linspace(0, 1, xf_t, dtype=np.float32)) ** 2
    fade_out = 1 - fade_in

    out: list[np.ndarray] = []
    tail: np.ndarray | None = None
    for start in range(0, n, chunk):
        seg = padded[start: start + pad + chunk + xf + pad]
        y = conv.convert(seg, params)
        piece = y[round(pad * ratio): round((pad + chunk + xf) * ratio)]
        if len(piece) < round((chunk + xf) * ratio):  # HuBERT/F0 hụt khung cuối — pad im lặng
            piece = np.pad(piece, (0, round((chunk + xf) * ratio) - len(piece)))
        if tail is not None:
            piece[:xf_t] = piece[:xf_t] * fade_in + tail * fade_out
        out.append(piece[:-xf_t])
        tail = piece[-xf_t:]
    return np.concatenate(out)[: round(n * ratio)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="file audio (wav/flac/mp3...)")
    ap.add_argument("--model", help="RVC v2 .pth")
    ap.add_argument("--index", help="faiss .index (tùy chọn)")
    ap.add_argument("--hubert", default=str(MODELS_DIR / "content-vec-best"), help="thư mục ContentVec (transformers)")
    ap.add_argument("--rmvpe", default=str(MODELS_DIR / "rmvpe.pt"))
    ap.add_argument("--dummy", action="store_true", help="dùng trọng số ngẫu nhiên (không cần tải model)")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--fp32", action="store_true", help="tắt fp16 trên CUDA")
    ap.add_argument("--pitch", type=float, default=0.0, help="pitch shift (bán cung)")
    ap.add_argument("--index-rate", type=float, default=0.5)
    ap.add_argument("--protect", type=float, default=0.33)
    ap.add_argument("--chunk-sec", type=float, default=30.0)
    ap.add_argument("--pad-sec", type=float, default=1.0)
    ap.add_argument("--xfade-sec", type=float, default=0.05)
    ap.add_argument("--runs", type=int, default=3, help="số lần chạy để lấy trung bình (lần đầu là warmup)")
    ap.add_argument("--output", help="mặc định spikes/out/rvc_offline_<tên>.wav")
    args = ap.parse_args()

    if not args.dummy and not args.model:
        ap.error("cần --model (hoặc --dummy)")

    device = pick_device(args.device)
    half = device.startswith("cuda") and not args.fp32
    res = Results("rvc_offline", device, params={k: v for k, v in vars(args).items()})
    reset_peak_memory(device)

    with timer(device) as t_load:
        conv = RVCConverter(
            None if args.dummy else args.model,
            None if args.dummy else args.hubert,
            None if args.dummy else args.rmvpe,
            None if args.dummy else args.index,
            device, half,
        )
    res.metrics["load_seconds"] = t_load["seconds"]
    res.metrics["model_sr"] = conv.tgt_sr
    print(f"Đã load model ({device}, fp16={half}) trong {t_load['seconds']:.2f}s, sr model = {conv.tgt_sr}")

    import librosa

    in_sr = int(librosa.get_samplerate(args.input))
    audio16k = load_audio(args.input, SR_16K)
    audio16k = signal.filtfilt(_BH, _AH, audio16k).astype(np.float32)
    duration = len(audio16k) / SR_16K
    params = ConvertParams(args.pitch, args.index_rate, args.protect)

    times: list[float] = []
    y = np.zeros(0, dtype=np.float32)
    for i in range(max(1, args.runs)):
        with timer(device) as t:
            y = convert_long(conv, audio16k, params, args.chunk_sec, args.pad_sec, args.xfade_sec)
        times.append(t["seconds"])
        print(f"  lần {i + 1}: {t['seconds']:.2f}s  RTF={t['seconds'] / duration:.3f}")

    measured = times[1:] or times
    rtf = float(np.mean(measured)) / duration
    res.metrics.update({
        "audio_seconds": duration,
        "process_seconds": times,
        "rtf": rtf,
        "faster_than_realtime": rtf < 1.0,
        "memory": memory_snapshot(device),
    })

    # Spec 3.3: output cùng sample rate với input, resample ở bước cuối.
    y = resample(y, conv.tgt_sr, in_sr)
    peak = float(np.abs(y).max()) if len(y) else 0.0
    if peak > 0.99:
        y = y * (0.99 / peak)
    out = Path(args.output) if args.output else OUT_DIR / f"rvc_offline_{Path(args.input).stem}.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, y, in_sr)
    print(f"RTF trung bình = {rtf:.3f} → {out}")
    if args.dummy:
        res.notes.append("dummy: trọng số ngẫu nhiên — chỉ kiểm tra đường code, số đo không đại diện chất lượng")
    res.save()
    free_memory(device)


if __name__ == "__main__":
    main()
