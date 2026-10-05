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
SEP_KEY = "sep:demucs"
SPK_KEY = "spk:embed"
PRETRAINED_ID = "rvc-pretrained-v2-40k"
DEMUCS_ID = "demucs-htdemucs"
SPEAKER_ID = "wavlm-base-plus-sv"


def tts_key(state: "EngineState", model_id: str) -> str:
    """Model TTS mặc định (settings.tts_model) dùng khóa "tts"; model khác "tts:<id>" (cùng nhóm, gỡ theo LRU)."""
    return TTS_KEY if model_id == state.settings.tts_model else f"{TTS_KEY}:{model_id}"


def pick_tts_model(state: "EngineState", lang: str) -> str:
    """Model mặc định nếu đọc được ngôn ngữ này; không thì model TTS đã cài có khai báo ngôn ngữ đó."""
    cat = state.catalog
    default = state.settings.tts_model
    m = cat.models.get(default)
    if m is None or not m.languages or lang in m.languages:
        return default
    for other in cat.models.values():
        if other.languages and lang in other.languages and cat.installed(other.id):
            return other.id
    return default


def rvc_voice_key(voice_id: str) -> str:
    return f"rvc:voice:{voice_id}"


def register_default_models(state: "EngineState") -> None:
    cat = state.catalog

    def load_tts_model(model_id: str, device: str):
        from .tts.f5_wrapper import F5Backend, ema_safetensors

        m = cat.require(model_id)
        voc = cat.require("vocos-mel-24khz")
        vocab = next((state.paths.models / f.path for f in m.files if f.path.endswith("vocab.txt")), None)
        ckpt = next(state.paths.models / f.path for f in m.files if not f.path.endswith("vocab.txt"))
        if ckpt.suffix == ".pt":
            ckpt = ema_safetensors(ckpt)
        return F5Backend(device, ckpt, vocab, m.arch or "F5TTS_v1_Base", cat.dir(voc.id), lowercase=m.lowercase)

    def load_tts(device: str):
        return load_tts_model(state.settings.tts_model, device)

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
    for m in cat.models.values():
        if m.languages and m.id != state.settings.tts_model:
            state.models.register(f"{TTS_KEY}:{m.id}", lambda device, mid=m.id: load_tts_model(mid, device), "tts")
    state.models.register(CONTENTVEC_KEY, load_contentvec, "rvc")
    state.models.register(RMVPE_KEY, load_rmvpe, "rvc")
    state.models.register(ASR_KEY, load_asr, "asr")

    def load_separator(device: str):
        from .preprocess.separate import Separator

        cat.require(DEMUCS_ID)
        return Separator(cat.dir(DEMUCS_ID), device)

    # Nhóm "sep": tách nhạc dùng trước khi train/đổi giọng → được gỡ khi chuyển sang model khác
    state.models.register(SEP_KEY, load_separator, "sep")

    def load_speaker(device: str):
        from .edit.diarize import MelStatsEmbedder, WavLMEmbedder

        # Chưa tải model nhận diện giọng: vẫn chạy được bằng đặc trưng log-mel (kém chính xác hơn)
        if SPEAKER_ID in cat.models and cat.installed(SPEAKER_ID):
            return WavLMEmbedder(cat.dir(SPEAKER_ID), device)
        return MelStatsEmbedder()

    state.models.register(SPK_KEY, load_speaker, "asr")


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


def ensure_train_nets(state: "EngineState", voice_id: str) -> None:
    """Đăng ký bộ mạng huấn luyện (generator + discriminator từ pretrained) của một giọng vào ModelManager."""
    key = f"train:{voice_id}"
    if state.models.is_registered(key):
        return

    def load(device: str):
        from .rvc.train.config import CONFIG_40K
        from .rvc.train.trainer import build_nets, load_pretrained

        cat = state.catalog
        cat.require(PRETRAINED_ID)
        nets = build_nets(CONFIG_40K, device)
        load_pretrained(nets, cat.path(PRETRAINED_ID, 0), cat.path(PRETRAINED_ID, 1))
        return nets

    state.models.register(key, load, "train")
