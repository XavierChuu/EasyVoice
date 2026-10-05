"""Chuẩn bị đoạn ref cho F5-TTS.

F5-TTS tự cắt ref còn ~12 s nhưng vẫn dùng NGUYÊN transcript → tỉ lệ ký tự/giây sai, câu sinh ra bị nén còn
vài trăm ms. Với ref dài, ta tự cắt audio tại một khoảng ngắt giữa hai từ (≤ MAX_SEC) và lấy transcript khớp
đúng đoạn đó từ timestamp từng từ của Whisper. Kết quả cache trong thư mục giọng (ref_tts.wav / ref_tts.txt).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path

from .. import audio_io

log = logging.getLogger(__name__)

MAX_SEC = 11.0  # chừa biên cho khoảng lặng F5 tự thêm, để F5 không cắt thêm lần nữa
MIN_SEC = 4.0
PAUSE_SEC = 0.12  # khe giữa hai từ đủ để cắt mà không cụt âm

Word = tuple[float, float, str]  # (start, end, text)


def pick_cut(words: list[Word], max_sec: float = MAX_SEC) -> int:
    """Số từ giữ lại: ưu tiên đoạn dài nhất kết thúc ở khe ngắt, cộng điểm cho cuối câu (. ! ?), trong giới hạn max_sec."""
    best, best_score = 0, -1.0
    for i, (_s, end, text) in enumerate(words):
        if end > max_sec:
            break
        gap = words[i + 1][0] - end if i + 1 < len(words) else 1.0
        if gap < PAUSE_SEC and i + 1 < len(words):
            continue
        score = end + (2.0 if text.rstrip().endswith((".", "!", "?")) else 0.0) + min(gap, 0.5) * 4
        if end >= MIN_SEC and score > best_score:
            best, best_score = i + 1, score
    if best:
        return best
    # Không có khe ngắt phù hợp: lấy đến từ cuối cùng còn nằm trong giới hạn.
    return sum(1 for w in words if w[1] <= max_sec)


def prepare_ref(voice_dir: Path, ref_audio: Path, ref_text: str, language: str,
                words_fn: Callable[[Path, str], list[Word]]) -> tuple[Path, str]:
    duration, _sr, _ch = audio_io.info(ref_audio)
    if duration <= MAX_SEC + 1.0:
        return ref_audio, ref_text
    out_wav, out_txt = voice_dir / "ref_tts.wav", voice_dir / "ref_tts.txt"
    if out_wav.exists() and out_txt.exists() and out_wav.stat().st_mtime >= ref_audio.stat().st_mtime:
        return out_wav, out_txt.read_text(encoding="utf-8")

    words = words_fn(ref_audio, language)
    n = pick_cut(words)
    if n == 0:
        log.warning("ref %.1fs: Whisper không tìm thấy từ nào, để F5-TTS tự cắt", duration)
        return ref_audio, ref_text
    end = words[n - 1][1]
    nxt = words[n][0] if n < len(words) else end + 0.3
    cut = min(end + max(0.05, (nxt - end) / 2), end + 0.3)
    audio, sr = audio_io.load(ref_audio)
    text = " ".join(w[2].strip() for w in words[:n]).strip()
    audio_io.save(out_wav, audio[: int(cut * sr)], sr)
    out_txt.write_text(text, encoding="utf-8")
    log.info("ref %.1fs → %.1fs cho TTS: %s", duration, cut, text)
    return out_wav, text
