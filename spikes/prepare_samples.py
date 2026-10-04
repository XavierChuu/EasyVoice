"""Chuẩn bị audio mẫu tiếng Anh để chạy spike ngay mà không cần tự thu âm.

Lấy đoạn ref tiếng Anh đi kèm gói f5-tts (`infer/examples/basic/basic_ref_en.wav`,
transcript: "Some call me nature, others call me mother nature.") và tạo:
  samples/en_ref.wav + samples/en_ref.txt   — ref cho F5-TTS
  samples/en_speech.wav                     — ~30 s (lặp đoạn ref, chèn khoảng lặng) cho RVC offline/real-time

Sau khi chạy F5-TTS, có thể thay en_speech.wav bằng output thật cho tự nhiên hơn:
  python prepare_samples.py --from-f5-out
"""

from __future__ import annotations

import argparse
from importlib.resources import files

import numpy as np
import soundfile as sf

from common import OUT_DIR, SPIKES_DIR

EN_REF_TEXT = "Some call me nature, others call me mother nature."
SAMPLES = SPIKES_DIR / "samples"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-f5-out", action="store_true", help="ghép các file out/f5/*.wav thành en_speech.wav")
    ap.add_argument("--seconds", type=float, default=30.0)
    args = ap.parse_args()
    SAMPLES.mkdir(parents=True, exist_ok=True)

    ref = files("f5_tts").joinpath("infer/examples/basic/basic_ref_en.wav")
    audio, sr = sf.read(str(ref), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    sf.write(SAMPLES / "en_ref.wav", audio, sr)
    (SAMPLES / "en_ref.txt").write_text(EN_REF_TEXT + "\n", encoding="utf-8")
    print(f"en_ref.wav: {len(audio) / sr:.2f}s @ {sr} Hz")

    if args.from_f5_out:
        parts = sorted((OUT_DIR / "f5").glob("*.wav"))
        if not parts:
            raise SystemExit("Chưa có out/f5/*.wav — chạy f5_tts_spike.py trước")
        clips = [sf.read(str(p), dtype="float32")[0] for p in parts]
        sr = sf.info(str(parts[0])).samplerate
    else:
        clips = [audio]
    gap = np.zeros(int(0.4 * sr), dtype=np.float32)
    out: list[np.ndarray] = []
    total = 0
    while total < args.seconds * sr:
        for c in clips:
            out += [c, gap]
            total += len(c) + len(gap)
    speech = np.concatenate(out)[: int(args.seconds * sr)]
    sf.write(SAMPLES / "en_speech.wav", speech, sr)
    print(f"en_speech.wav: {len(speech) / sr:.1f}s @ {sr} Hz")


if __name__ == "__main__":
    main()
