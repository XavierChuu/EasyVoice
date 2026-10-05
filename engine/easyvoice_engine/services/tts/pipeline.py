"""Job TTS: chuẩn hóa → tách câu → render từng câu (nghe được câu đã xong) → ghép có khoảng nghỉ + crossfade → .srt."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import numpy as np

from ...core.job_queue import JobContext, TtsSentence
from .. import audio_io
from .chunker import split_long, split_sentences
from .f5_wrapper import TtsBackend
from .text_normalize import normalize


# Chữ cái chỉ tiếng Việt mới có — đủ để nhận ra văn bản tiếng Việt (giọng mẫu tiếng Anh vẫn có thể đọc tiếng Việt).
_VI_CHARS = re.compile("[đơưăạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]", re.IGNORECASE)


def text_language(text: str, voice_lang: str) -> str:
    if _VI_CHARS.search(text):
        return "vi"
    return voice_lang if voice_lang in ("vi", "en") else "en"


def plan_sentences(text: str) -> list[str]:
    out: list[str] = []
    for s in split_sentences(text):
        out += split_long(s)
    return out


VoiceKey = tuple[str, str | None]  # (profile_id, variant_id)


def plan_parts(parts: list[tuple[str, VoiceKey]]) -> list[tuple[str, VoiceKey]]:
    """Tách từng đoạn (đã gắn giọng) thành câu; câu bị đoạn chọn giọng cắt ngang thành nhiều câu riêng."""
    out: list[tuple[str, VoiceKey]] = []
    for text, key in parts:
        out += [(s, key) for s in plan_sentences(text)]
    return out


class VoiceRef:
    def __init__(self, ref_audio: Path, ref_text: str, cache_dir: Path, language: str) -> None:
        self.ref_audio, self.ref_text, self.cache_dir, self.language = ref_audio, ref_text, cache_dir, language


class TtsRender:
    """Trạng thái render của một job (giữ lại để render lại một câu riêng lẻ)."""

    def __init__(self, out_dir: Path, lang: str, refs: dict[VoiceKey, VoiceRef], default: VoiceKey, speed: float,
                 seed: int, pause_ms: int, user_dict: list[tuple[str, str]]) -> None:
        self.out_dir = out_dir
        self.lang, self.refs, self.default = lang, refs, default
        self.speed, self.seed, self.pause_ms, self.user_dict = speed, seed, pause_ms, user_dict
        self.sr = 24000
        self.attempts: dict[int, int] = {}
        self.model_id = ""
        # Chế độ "Qua RVC": (wav, sr, profile_id) → (wav, sr). None = đọc trực tiếp.
        self.chain: Callable[[np.ndarray, int, str], tuple[np.ndarray, int]] | None = None
        self.out_sr: int | None = None  # chain: mọi câu đưa về cùng sample rate của model RVC

    def sentence_path(self, i: int) -> Path:
        return self.out_dir / f"s{i:03d}.wav"

    def raw_path(self, i: int) -> Path:
        return self.out_dir / f"s{i:03d}.f5.wav"

    def profile_of(self, s: TtsSentence) -> str:
        return s.profile_id or self.default[0]

    def ref_for(self, s: TtsSentence) -> VoiceRef:
        return self.refs[(s.profile_id, s.variant_id) if s.profile_id else self.default]

    def render_one(self, backend: TtsBackend, s: TtsSentence) -> None:
        attempt = self.attempts.get(s.index, 0)
        text = normalize(s.text, self.lang, self.user_dict)
        ref = self.ref_for(s)
        wav = backend.synthesize(text, ref.ref_audio, ref.ref_text, self.speed, self.seed + 7919 * attempt + s.index)
        if self.chain is not None:  # lượt 1: chỉ lưu bản F5-TTS, lượt 2 mới đổi giọng
            audio_io.save(self.raw_path(s.index), wav, backend.sample_rate)
            return
        self.sr = backend.sample_rate
        audio_io.save(self.sentence_path(s.index), audio_io.peak_normalize(wav), self.sr)
        s.duration_sec = len(wav) / self.sr

    def convert_one(self, s: TtsSentence) -> None:
        """Lượt 2 của chế độ "Qua RVC": đưa câu qua model RVC của giọng đọc câu đó."""
        assert self.chain is not None
        wav, sr = audio_io.load(self.raw_path(s.index))
        y, y_sr = self.chain(wav, sr, self.profile_of(s))
        out_sr = self.out_sr or y_sr
        y = audio_io.resample(y, y_sr, out_sr)
        self.sr = out_sr
        audio_io.save(self.sentence_path(s.index), audio_io.peak_normalize(y), out_sr)
        s.duration_sec = len(y) / out_sr

    def join(self, sentences: list[TtsSentence], only_done: bool = False) -> np.ndarray:
        parts = [audio_io.load(self.sentence_path(s.index))[0] for s in sentences
                 if not only_done or s.status == "done"]
        return audio_io.crossfade_concat(parts, self.sr, self.pause_ms)


def run_tts(ctx: JobContext, render: TtsRender, backend_fn: Callable[[], TtsBackend],
            register_file: Callable[[Path, str], str]) -> None:
    sentences = ctx.job.sentences or []
    todo = [s for s in sentences if s.status in ("queued", "redo", "rendering")]
    ctx.log(f"{len(todo)} câu cần render · {ctx.job.device}")
    backend = backend_fn()
    chain = render.chain is not None

    def finish(s: TtsSentence) -> None:
        s.status, s.progress = "done", 1.0
        ctx.job.files[f"sentence:{s.index}"] = register_file(render.sentence_path(s.index), f"sentence-{s.index + 1}.wav")
        done = sum(1 for x in sentences if x.status == "done")
        ctx.progress(done / len(sentences))

    for s in todo:
        ctx.check_cancel()
        redo = s.status == "redo"
        if redo:
            render.attempts[s.index] = render.attempts.get(s.index, 0) + 1
        s.status = "rendering"
        s.progress = 0.1
        ctx.emit()
        render.render_one(backend, s)
        if chain:
            s.progress = 0.5
            ctx.emit()
        else:
            finish(s)
    if chain:  # lượt 2: nạp RVC một lần (model TTS được gỡ theo LRU) rồi đổi giọng mọi câu
        ctx.log("Đổi giọng các câu qua RVC")
        for s in todo:
            ctx.check_cancel()
            render.convert_one(s)
            finish(s)
    out = render.join(sentences)
    path = audio_io.save(render.out_dir / "output.wav", out, render.sr)
    ctx.job.files["output"] = register_file(path, "output.wav")
    ctx.job.output_duration_sec = len(out) / render.sr
    srt = audio_io.srt([s.duration_sec or 0 for s in sentences], [s.text for s in sentences], render.pause_ms)
    srt_path = render.out_dir / "output.srt"
    srt_path.write_text(srt, encoding="utf-8")
    ctx.job.files["srt"] = register_file(srt_path, "output.srt")
    ctx.log(f"Xong · {ctx.job.output_duration_sec:.1f}s audio")
