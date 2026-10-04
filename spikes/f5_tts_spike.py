"""Spike Phase 0 — F5-TTS zero-shot tiếng Việt, gọi thẳng thư viện f5-tts (không API, không UI).

Đo: thời gian load, RTF từng câu (thời gian render / thời lượng audio sinh ra), bộ nhớ GPU đỉnh.
Mục tiêu spec mục 5: RTF ≤ 0.5 trên RTX 3060.

Văn bản đầu vào phải đã chuẩn hóa sẵn (số, ngày, đơn vị viết thành chữ) — bộ chuẩn hóa tiếng Việt làm ở Phase 1.

Ví dụ:
  python f5_tts_spike.py --ckpt models/f5-vi/model.pt --vocab models/f5-vi/vocab.txt \
      --ref-audio samples/ref.wav --ref-text "nội dung chính xác của đoạn ref" \
      --vocoder models/vocos-mel-24khz
  python f5_tts_spike.py ... --nfe 16      # thử số bước ODE thấp hơn (nhanh hơn, chất lượng giảm)
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

from common import (
    MODELS_DIR, OUT_DIR, SPIKES_DIR, Results, free_memory, memory_snapshot, percentiles, pick_device,
    reset_peak_memory, timer,
)


def read_texts(path: Path) -> list[str]:
    lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines()]
    return [ln for ln in lines if ln and not ln.startswith("#")]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", help="checkpoint F5-TTS (.pt/.safetensors). Bỏ trống = bản gốc SWivid (tiếng Anh/Trung)")
    ap.add_argument("--vocab", help="vocab.txt đi kèm checkpoint (bắt buộc với checkpoint tiếng Việt)")
    ap.add_argument("--model", default="F5TTS_v1_Base",
                    help="cấu hình kiến trúc của checkpoint: F5TTS_v1_Base hoặc F5TTS_Base (nhiều bản fine-tune cũ)")
    ap.add_argument("--vocoder", default=str(MODELS_DIR / "vocos-mel-24khz"),
                    help="thư mục vocos (config.yaml + pytorch_model.bin); không có thì thư viện tự tải từ HF")
    ap.add_argument("--ref-audio", required=True, help="5-12 s audio sạch")
    ap.add_argument("--ref-text", required=True, help="transcript chính xác của ref (không dùng Whisper trong spike)")
    ap.add_argument("--texts", default=str(SPIKES_DIR / "texts_vi.txt"), help="mỗi dòng một câu/đoạn")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--nfe", type=int, default=32, help="số bước ODE (mặc định 32)")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--warmup", type=int, default=1, help="số câu chạy trước để làm nóng (không tính)")
    args = ap.parse_args()

    if args.ckpt and not args.vocab:
        ap.error("checkpoint fine-tune cần --vocab tương ứng")

    from f5_tts.api import F5TTS

    device = pick_device(args.device)
    res = Results("f5_tts", device, params={k: v for k, v in vars(args).items()})
    reset_peak_memory(device)

    vocoder_dir = Path(args.vocoder)
    with timer(device) as t_load:
        tts = F5TTS(
            model=args.model,
            ckpt_file=args.ckpt or "",
            vocab_file=args.vocab or "",
            vocoder_local_path=str(vocoder_dir) if (vocoder_dir / "config.yaml").exists() else None,
            device=device,
        )
    res.metrics["load_seconds"] = t_load["seconds"]
    res.metrics["memory_after_load"] = memory_snapshot(device)
    print(f"Đã load F5-TTS ({device}) trong {t_load['seconds']:.2f}s")

    texts = read_texts(Path(args.texts))
    for _ in range(min(args.warmup, len(texts))):
        tts.infer(args.ref_audio, args.ref_text, texts[0], nfe_step=args.nfe, speed=args.speed,
                  seed=args.seed, show_info=lambda *a: None)

    out_dir = OUT_DIR / "f5"
    out_dir.mkdir(parents=True, exist_ok=True)
    rows, rtfs, mps_peak = [], [], 0.0
    total_audio = total_proc = 0.0
    for i, text in enumerate(texts):
        with timer(device) as t:
            wav, sr, _ = tts.infer(args.ref_audio, args.ref_text, text, nfe_step=args.nfe, speed=args.speed,
                                   seed=args.seed, show_info=lambda *a: None)
        wav = np.asarray(wav, dtype=np.float32)
        dur = len(wav) / sr
        rtf = t["seconds"] / dur if dur else float("inf")
        rtfs.append(rtf)
        total_audio += dur
        total_proc += t["seconds"]
        mem = memory_snapshot(device)
        mps_peak = max(mps_peak, mem.get("driver_allocated_mb") or 0.0)
        path = out_dir / f"{i:02d}.wav"
        sf.write(path, wav, sr)
        rows.append({"index": i, "chars": len(text), "audio_s": dur, "process_s": t["seconds"], "rtf": rtf})
        print(f"  [{i:02d}] {len(text):4d} ký tự  audio {dur:5.1f}s  render {t['seconds']:5.2f}s  RTF {rtf:.3f}")

    overall = total_proc / total_audio if total_audio else float("inf")
    res.metrics.update({
        "sample_rate": tts.target_sample_rate,
        "sentences": rows,
        "rtf": percentiles(rtfs),
        "rtf_overall": overall,
        "meets_target_rtf_0_5": overall <= 0.5,
        "memory": memory_snapshot(device),
    })
    if mps_peak:
        res.metrics["mps_driver_peak_mb_sampled"] = mps_peak
    print(f"RTF tổng = {overall:.3f} (mục tiêu ≤ 0.5 trên RTX 3060). Audio: {out_dir}")
    res.save()
    free_memory(device)


if __name__ == "__main__":
    main()
