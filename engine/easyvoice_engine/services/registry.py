"""Đăng ký các model mặc định vào ModelManager (load lười — chỉ nạp khi job cần).

Test thay model thật bằng model giả bằng cách gọi lại state.models.register(key, loader, group)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..core.errors import EngineError

if TYPE_CHECKING:
    from ..core.state import EngineState

TTS_KEY = "tts"
CONTENTVEC_KEY = "rvc:contentvec"
RMVPE_KEY = "rvc:rmvpe"
ASR_KEY = "asr:whisper"


def rvc_voice_key(voice_id: str) -> str:
    return f"rvc:voice:{voice_id}"


def register_default_models(state: "EngineState") -> None:
    cat = state.catalog

    def load_tts(device: str):
        from .tts.f5_wrapper import F5Backend

        m = cat.require(state.settings.tts_model)
        voc = cat.require("vocos-mel-24khz")
        vocab = next((state.paths.models / f.path for f in m.files if f.path.endswith("vocab.txt")), None)
        ckpt = next(state.paths.models / f.path for f in m.files if not f.path.endswith("vocab.txt"))
        return F5Backend(device, ckpt, vocab, m.arch or "F5TTS_v1_Base", cat.dir(voc.id))

    def load_contentvec(device: str):
        from .rvc.infer import ContentEncoder

        cat.require("contentvec")
        return ContentEncoder(cat.dir("contentvec"), device, state.half())

    def load_rmvpe(device: str):
        from .rvc.infer import F0Extractor

        cat.require("rmvpe")
        return F0Extractor(cat.path("rmvpe"), device, state.half())

    def load_asr(device: str):
        from .preprocess.asr import Whisper

        cat.require("whisper-small")
        return Whisper(cat.dir("whisper-small"), device)

    state.models.register(TTS_KEY, load_tts, "tts")
    state.models.register(CONTENTVEC_KEY, load_contentvec, "rvc")
    state.models.register(RMVPE_KEY, load_rmvpe, "rvc")
    state.models.register(ASR_KEY, load_asr, "asr")


def ensure_rvc_voice(state: "EngineState", voice_id: str):
    """Nạp synthesizer RVC của một giọng (qua ModelManager)."""
    key = rvc_voice_key(voice_id)
    if not state.models.is_registered(key):
        profile = state.voices.get(voice_id)
        if not profile.rvc_model:
            raise EngineError("NO_STS_VOICE")
        d = state.voices.dir(voice_id)

        def load(device: str):
            from .rvc.infer import RvcModel

            return RvcModel.from_files(d / profile.rvc_model, d / "rvc.json", device, state.half())

        state.models.register(key, load, "rvc")
    return state.models.get(key)
