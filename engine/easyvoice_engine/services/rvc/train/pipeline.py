"""Job huấn luyện giọng "Chất lượng cao" (spec 3.1). Mỗi bước là một stage có tiến độ riêng:

  preprocess (0-15%)  FFmpeg → tách nhạc nền (Demucs) → khử nhiễu nhẹ → cắt câu theo khoảng lặng → resample;
                      kiểm tra dataset (thời lượng sạch, số đoạn, cảnh báo < 8 phút); chọn ref + transcript cho TTS
  extract   (15-30%)  ContentVec (768-d) + F0 bằng RMVPE
  train     (30-92%)  preset Nhanh / Cân bằng / Kỹ, lưu checkpoint định kỳ
  index     (92-100%) faiss index + file nghe thử

Mỗi stage xong ghi dấu vào train/state.json → hủy rồi tiếp tục sẽ bỏ qua stage đã xong, train chạy tiếp từ checkpoint.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from ....core.errors import EngineError
from ....core.job_queue import JobContext
from ... import audio_io
from ...preprocess import slice as slicing
from ...preprocess.denoise import light_denoise
import dataclasses

from .config import CONFIG_40K, PRESET_EPOCHS, auto_batch_size

if TYPE_CHECKING:
    from ....core.state import EngineState

SR_16K = 16000
MIN_CLEAN_SEC = 10.0  # ít hơn thế thì không train được
WARN_CLEAN_SEC = 8 * 60  # spec: cảnh báo nếu dưới 8 phút
RANGES = {"preprocess": (0.0, 0.15), "extract": (0.15, 0.30), "train": (0.30, 0.92), "index": (0.92, 1.0)}


@dataclass
class TrainSpec:
    voice_id: str
    preset: str
    separate: bool
    epochs: int
    sources: list[str] = field(default_factory=list)  # tên file trong train/sources/
    done: list[str] = field(default_factory=list)  # stage đã xong
    epochs_done: int = 0
    clean_sec: float = 0.0
    segments: int = 0

    @classmethod
    def load(cls, path: Path) -> "TrainSpec":
        return cls(**json.loads(path.read_text(encoding="utf-8")))

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(self.__dict__, indent=2), encoding="utf-8")


def train_dir(state: "EngineState", voice_id: str) -> Path:
    return state.voices.dir(voice_id) / "train"


def progress_of(spec: TrainSpec) -> float:
    if "index" in spec.done:
        return 1.0
    if "train" in spec.done:
        return RANGES["index"][0]
    if spec.epochs_done:
        a, b = RANGES["train"]
        return a + (b - a) * spec.epochs_done / spec.epochs
    if "extract" in spec.done:
        return RANGES["train"][0]
    return RANGES["extract"][0] if "preprocess" in spec.done else 0.0


def run_training(ctx: JobContext, state: "EngineState", sep_key: str, asr_key: str, contentvec_key: str,
                 rmvpe_key: str) -> None:
    from .. import THIRD_PARTY  # noqa: F401

    voice_id = ctx.job.profile_id or ""
    root = train_dir(state, voice_id)
    spec_path = root / "state.json"
    spec = TrainSpec.load(spec_path)
    ctx.job.total_epochs = spec.epochs
    data = root / "data"
    state.models.unload_all()  # không giữ model TTS/khác trên GPU khi train (spec mục 5)

    def stage(name: str, frac: float) -> None:
        a, b = RANGES[name]
        ctx.progress(a + (b - a) * frac, name)

    # ---------- preprocess ----------
    if "preprocess" not in spec.done:
        stage("preprocess", 0.0)
        shutil.rmtree(data, ignore_errors=True)
        for d in ("0_gt", "1_16k"):
            (data / d).mkdir(parents=True, exist_ok=True)
        sr = CONFIG_40K.sample_rate
        separator = state.models.get(sep_key) if spec.separate else None
        all_chunks: list[np.ndarray] = []
        n_seg, clean = 0, 0.0
        for k, name in enumerate(spec.sources):
            ctx.log(f"Tiền xử lý {name}")
            audio, _ = audio_io.load(root / "sources" / name, sr)
            if separator is not None:
                audio, _acc = separator.separate(audio, sr)
                ctx.log("  đã tách nhạc nền")
            audio, denoised = light_denoise(audio, sr)
            audio = slicing.high_pass(audio, sr)
            chunks = slicing.speech_chunks(audio, sr)
            all_chunks += chunks
            for chunk in chunks:
                for seg in slicing.segments(chunk, sr):
                    stem = f"{k:02d}_{n_seg:05d}"
                    audio_io.save(data / "0_gt" / f"{stem}.wav", seg, sr)
                    audio_io.save(data / "1_16k" / f"{stem}.wav", audio_io.resample(seg, sr, SR_16K), SR_16K)
                    n_seg += 1
                clean += len(chunk) / sr
            stage("preprocess", (k + 1) / len(spec.sources))
            ctx.check_cancel()
        spec.clean_sec, spec.segments = clean, n_seg
        ctx.log(f"Dataset: {n_seg} đoạn · {clean / 60:.1f} phút giọng nói sạch")
        if clean < MIN_CLEAN_SEC or n_seg == 0:
            raise EngineError("BAD_FILE", f"chỉ có {clean:.0f} s giọng nói sạch — quá ít để huấn luyện")
        if clean < WARN_CLEAN_SEC:
            ctx.log(f"Cảnh báo: dưới {WARN_CLEAN_SEC // 60} phút — giọng có thể chưa giống, nên thêm dữ liệu")
        _make_tts_ref(ctx, state, voice_id, all_chunks, sr, asr_key)
        spec.done.append("preprocess")
        spec.save(spec_path)

    # ---------- extract ----------
    if "extract" not in spec.done:
        import torch

        stage("extract", 0.0)
        for d in ("2_f0", "2_f0nsf", "3_feat"):
            (data / d).mkdir(parents=True, exist_ok=True)
        encoder = state.models.get(contentvec_key)
        f0x = state.models.get(rmvpe_key)
        from ..infer import f0_to_coarse

        wavs = sorted((data / "1_16k").glob("*.wav"))
        for i, w in enumerate(wavs):
            audio, _ = audio_io.load(w)
            x = torch.from_numpy(audio)
            f0 = f0x(x)
            np.save(data / "2_f0nsf" / f"{w.stem}.npy", f0.astype(np.float32))
            np.save(data / "2_f0" / f"{w.stem}.npy", f0_to_coarse(f0.copy()))
            feats = encoder(x)[0].float().cpu().numpy()
            np.save(data / "3_feat" / f"{w.stem}.npy", feats)
            if i % 5 == 0 or i == len(wavs) - 1:
                stage("extract", (i + 1) / len(wavs))
                ctx.check_cancel()
        ctx.log(f"Đã trích đặc trưng ContentVec + F0 (RMVPE) cho {len(wavs)} đoạn")
        spec.done.append("extract")
        spec.save(spec_path)
        state.models.unload_all()

    # ---------- train ----------
    if "train" not in spec.done:
        from .trainer import train

        stage("train", spec.epochs_done / spec.epochs)
        nets = state.models.get(f"train:{voice_id}")

        def on_progress(p) -> None:
            ctx.job.epoch = p.epoch
            stage("train", p.fraction)

        def on_checkpoint(epoch_done: int) -> None:
            spec.epochs_done = epoch_done
            spec.save(spec_path)

        device = ctx.job.device or "cpu"
        cfg = dataclasses.replace(CONFIG_40K, batch_size=auto_batch_size(device))
        train(nets, cfg, data, root / "ckpt", spec.epochs, device, on_progress, ctx.log,
              ctx.check_cancel, save_every=max(1, min(10, spec.epochs // 10 or 1)), on_checkpoint=on_checkpoint)
        spec.epochs_done = spec.epochs
        spec.done.append("train")
        spec.save(spec_path)

    # ---------- index + export + preview ----------
    if "index" not in spec.done:
        from .index import build_index
        from .trainer import export_generator

        stage("index", 0.0)
        vdir = state.voices.dir(voice_id)
        nets = state.models.get(f"train:{voice_id}")
        if "train" in spec.done and not (root / "ckpt" / "latest.pt").exists():
            raise EngineError("UNKNOWN", "mất checkpoint huấn luyện")
        _load_latest(nets, root)
        meta = export_generator(nets.net_g, CONFIG_40K, vdir)
        state.models.unload(f"train:{voice_id}")
        n = build_index(data / "3_feat", vdir / "model.index")
        ctx.log(f"Index faiss: {n} vector")
        stage("index", 0.5)
        state.voices.finish_training(voice_id, meta["sr"])
        _make_preview(ctx, state, voice_id, data)
        spec.done.append("index")
        spec.save(spec_path)
        shutil.rmtree(root / "ckpt", ignore_errors=True)  # giữ dataset đã xử lý, bỏ checkpoint lớn
        ctx.log("Xong · model.safetensors + model.index + preview.wav")


def _load_latest(nets, root: Path) -> None:
    import torch

    ck = torch.load(str(root / "ckpt" / "latest.pt"), map_location="cpu", weights_only=True)
    nets.net_g.load_state_dict(ck["g"])
    nets.net_g.eval()


def _make_tts_ref(ctx: JobContext, state: "EngineState", voice_id: str, chunks: list[np.ndarray], sr: int,
                  asr_key: str) -> None:
    """Giọng "Chất lượng cao" dùng được cho cả TTS: tự chọn một đoạn sạch 5-12 s + transcript Whisper (ADR-0001)."""
    from ...voices import REF_SR, clean_reference

    ref = slicing.pick_reference(chunks, sr)
    if ref is None:
        ctx.log("Không tìm được đoạn 5-12 s liền mạch để làm giọng mẫu TTS — giọng chỉ dùng cho Đổi giọng")
        return
    clean, _ = clean_reference(audio_io.resample(ref, sr, REF_SR), REF_SR)
    path = state.voices.dir(voice_id) / "ref.wav"
    audio_io.save(path, clean, REF_SR)
    try:
        profile = state.voices.get(voice_id)
        text = state.models.get(asr_key).transcribe(path, profile.language)
    except EngineError as exc:
        path.unlink(missing_ok=True)
        ctx.log(f"Chưa có transcript tự động ({exc.code}) — giọng chỉ dùng cho Đổi giọng; tải Whisper để dùng cho TTS")
        return
    finally:
        state.models.unload(asr_key)
    if not text.strip():
        path.unlink(missing_ok=True)
        ctx.log("Whisper không nhận ra lời trong đoạn mẫu — giọng chỉ dùng cho Đổi giọng")
        return
    state.voices.set_tts_ref(voice_id, "ref.wav", text.strip())
    ctx.log(f"Đã chọn đoạn mẫu {len(clean) / REF_SR:.1f} s cho TTS: “{text.strip()[:60]}”")


def _make_preview(ctx: JobContext, state: "EngineState", voice_id: str, data: Path) -> None:
    """File nghe thử: đổi giọng ~6 s dữ liệu bằng model vừa train (spec 3.1)."""
    try:
        from ...registry import CONTENTVEC_KEY, RMVPE_KEY, ensure_rvc_voice
        from ..infer import SR_16K as S16, ConvertParams, Index, convert_long

        wavs = sorted((data / "1_16k").glob("*.wav"))[:2]
        src = np.concatenate([audio_io.load(w)[0] for w in wavs]) if wavs else np.zeros(0, np.float32)
        if src.size < S16:
            return
        model = ensure_rvc_voice(state, voice_id)
        vdir = state.voices.dir(voice_id)
        y = convert_long(model, state.models.get(CONTENTVEC_KEY), state.models.get(RMVPE_KEY), Index(vdir / "model.index"),
                         src[: 8 * S16], ConvertParams())
        audio_io.save(vdir / "preview.wav", audio_io.peak_normalize(y), model.sr)
    except Exception as exc:  # noqa: BLE001 — file nghe thử không được làm hỏng cả job
        ctx.log(f"Không tạo được file nghe thử: {exc}")
