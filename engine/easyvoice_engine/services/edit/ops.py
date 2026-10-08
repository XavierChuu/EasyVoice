"""Các thao tác của Edit Audio. Mỗi hàm chạy trong một job (JobQueue) và tạo asset MỚI thay vì sửa asset cũ."""

from __future__ import annotations

import math
import re
from typing import TYPE_CHECKING

import numpy as np

from ...core.errors import EngineError
from ...core.job_queue import JobContext
from .. import audio_io
from . import dsp
from .store import PROJECT_SR, EditAsset, EditTimeline, EditWord, SpeakerTurn

if TYPE_CHECKING:
    from ...core.state import EngineState

SR = PROJECT_SR
FILTER_PAD = 0.5  # giây ngữ cảnh mỗi bên khi lọc một đoạn (bộ lọc ổn định trước khi vào vùng chọn)
RETEXT_BEFORE, RETEXT_AFTER, RETEXT_MAX_SEL = 9.0, 4.0, 15.0
SPLICE = 0.04  # giây crossfade hai đầu đoạn sửa lời


def spread_words(text: str, start: float, duration: float) -> list[EditWord]:
    """Thời điểm ước lượng cho từng từ (theo độ dài ký tự) — dùng cho audio sinh ra từ văn bản."""
    toks = text.split()
    if not toks or duration <= 0:
        return []
    weights = np.array([len(t) + 1 for t in toks], dtype=float)
    edges = start + np.concatenate([[0.0], np.cumsum(weights)]) / weights.sum() * duration
    return [EditWord(start=round(float(edges[i]), 3), end=round(float(edges[i + 1]), 3), text=t) for i, t in enumerate(toks)]


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) if x.size else 0.0


# ---------------------------------------------------------------- chép lời
def transcribe_asset(state: "EngineState", pid: str, aid: str, language: str | None) -> EditAsset:
    from ..registry import ASR_KEY

    asset = state.edit.asset(pid, aid)
    lang = language if language in ("vi", "en") else None
    words = state.models.get(ASR_KEY).words(state.edit.asset_path(pid, aid), lang)
    asset.words = [EditWord(start=round(s, 3), end=round(e, 3), text=w.strip()) for s, e, w in words if w.strip()]
    asset.language = lang or asset.language
    return state.edit.update_asset(pid, asset)


def run_transcribe(state: "EngineState", ctx: JobContext, pid: str, asset_ids: list[str], language: str | None) -> dict:
    n = 0
    for i, aid in enumerate(asset_ids):
        ctx.progress(i / len(asset_ids), "transcribe")
        n += len(transcribe_asset(state, pid, aid, language).words or [])
    ctx.log(f"Đã chép lời {len(asset_ids)} đoạn · {n} từ")
    return {"words": n}


# ---------------------------------------------------------------- nhận diện người nói
def run_diarize(state: "EngineState", ctx: JobContext, pid: str, asset_ids: list[str], num_speakers: int | None) -> dict:
    from ..registry import SPK_KEY
    from .diarize import SR as DSR, diarize

    store = state.edit
    others = [t.speaker for a in store.assets(pid) if a.id not in asset_ids for t in (a.turns or [])]
    base = max(others, default=-1) + 1  # người nói mới đánh số tiếp, không trùng với đoạn đã nhận diện trước
    ctx.progress(0.02, "diarize")
    items = [(aid, audio_io.resample(store.load(pid, aid), SR, DSR)) for aid in asset_ids]
    embedder = state.models.get(SPK_KEY)
    ctx.log(f"Đặc trưng giọng: {embedder.name}" + (" (chưa tải model nhận diện giọng — kém chính xác hơn)"
                                                    if embedder.name != "wavlm-sv" else ""))
    turns, n = diarize(items, embedder, num_speakers, on_progress=lambda p: ctx.progress(0.05 + 0.9 * p, "diarize"))
    for aid in asset_ids:
        a = store.asset(pid, aid)
        a.turns = [SpeakerTurn(start=s, end=e, speaker=base + lb) for s, e, lb in turns[aid]]
        store.update_asset(pid, a)
    ctx.log(f"Tìm thấy {n} người nói")
    return {"speakers": n, "base": base, "embedder": embedder.name}


# ---------------------------------------------------------------- tách nhạc nền
def run_separate(state: "EngineState", ctx: JobContext, pid: str, asset_ids: list[str]) -> dict:
    from ..registry import SEP_KEY

    store = state.edit
    pairs: dict[str, list[str]] = {}
    for i, aid in enumerate(asset_ids):
        ctx.progress(0.05 + 0.9 * i / len(asset_ids), "separate")
        src = store.asset(pid, aid)
        vocals, music = state.models.get(SEP_KEY).separate(store.load(pid, aid), SR)
        v = store.add_asset(pid, vocals, SR, f"{src.name} · giọng", "separate", words=src.words, language=src.language)
        if src.turns is not None:
            v.turns = src.turns
            store.update_asset(pid, v)
        m = store.add_asset(pid, music, SR, f"{src.name} · nhạc nền", "separate")
        pairs[aid] = [v.id, m.id]
    ctx.log(f"Đã tách nhạc nền {len(asset_ids)} đoạn (Demucs)")
    return {"pairs": pairs}


# ---------------------------------------------------------------- lọc / đổi giọng một đoạn
def run_filter(state: "EngineState", ctx: JobContext, pid: str, segments: list, name: str, amount: float | None) -> dict:
    store = state.edit
    out = []
    note = ""
    for i, seg in enumerate(segments):
        ctx.progress(i / len(segments), "filter")
        audio, pre, n = store.segment(pid, seg.asset_id, seg.offset, seg.duration, FILTER_PAD)
        y, note = dsp.apply_filter(name, audio, SR, amount)
        src = store.asset(pid, seg.asset_id)
        a = store.add_asset(pid, y[pre: pre + n], SR, f"{src.name} · {note}", "filter",
                            words=_shift_words(src.words, seg.offset, seg.duration), language=src.language)
        out.append(a.id)
    ctx.log(f"Đã áp dụng: {note} · {len(segments)} đoạn")
    return {"assets": out}


def _shift_words(words: list[EditWord] | None, offset: float, duration: float) -> list[EditWord] | None:
    """Từ nằm trong đoạn [offset, offset+duration] của asset gốc, đổi về thời gian của asset mới (bắt đầu từ 0)."""
    if words is None:
        return None
    out = []
    for w in words:
        mid = (w.start + w.end) / 2
        if offset <= mid < offset + duration:
            out.append(EditWord(start=round(max(0.0, w.start - offset), 3), end=round(min(duration, w.end - offset), 3), text=w.text))
    return out


def run_convert(state: "EngineState", ctx: JobContext, pid: str, segments: list, profile_id: str, pitch: float) -> dict:
    from ..registry import CONTENTVEC_KEY, RMVPE_KEY, ensure_rvc_voice
    from ..rvc.infer import SR_16K, ConvertParams, Index, convert_long

    store = state.edit
    p = state.voices.get(profile_id)
    out = []
    for i, seg in enumerate(segments):
        audio, pre, n = store.segment(pid, seg.asset_id, seg.offset, seg.duration, 0.3)
        model = ensure_rvc_voice(state, profile_id)
        d = state.voices.dir(profile_id)
        index = Index(d / p.rvc_index) if p.rvc_index and (d / p.rvc_index).exists() else None
        base = i / len(segments)
        y = convert_long(model, state.models.get(CONTENTVEC_KEY), state.models.get(RMVPE_KEY), index,
                         audio_io.resample(audio, SR, SR_16K), ConvertParams(pitch_shift=pitch + p.pitch_shift),
                         on_progress=lambda q: ctx.progress(base + q / len(segments), "convert"))
        y = audio_io.resample(y, model.sr, SR)
        y = y[pre: pre + n]
        if len(y) < n:
            y = np.pad(y, (0, n - len(y)))
        src = store.asset(pid, seg.asset_id)
        a = store.add_asset(pid, y, SR, f"{src.name} → {p.name}", "convert",
                            words=_shift_words(src.words, seg.offset, seg.duration), language=src.language)
        out.append(a.id)
    ctx.log(f"Đã đổi {len(segments)} đoạn sang giọng {p.name}")
    return {"assets": out}


# ---------------------------------------------------------------- đọc văn bản bằng một giọng đã lưu
def run_speak(state: "EngineState", ctx: JobContext, pid: str, profile_id: str, variant_id: str | None, text: str,
              speed: float, seed: int) -> dict:
    from ..registry import ASR_KEY, pick_tts_model, tts_key
    from ..tts.pipeline import text_language
    from ..tts.ref_prep import prepare_ref
    from ..tts.text_normalize import normalize

    p, ref, ref_text, cache = state.voices.tts_ref(profile_id, variant_id)
    lang = text_language(text, p.language)
    try:
        ref, ref_text = prepare_ref(cache, ref, ref_text, p.language, lambda path, lg: state.models.get(ASR_KEY).words(path, lg))
    except EngineError as exc:
        ctx.log(f"Không chuẩn bị được ref: {exc}")
    ctx.progress(0.1, "speak")
    backend = state.models.get(tts_key(state, pick_tts_model(state, lang)))
    wav = backend.synthesize(normalize(text, lang), ref, ref_text, speed, seed)
    y = audio_io.resample(wav, backend.sample_rate, SR)
    a = state.edit.add_asset(pid, y, SR, f"{p.name}: {text[:40]}", "speak",
                             words=spread_words(text, 0.0, len(y) / SR), language=lang)
    ctx.log(f"Đã đọc {len(y) / SR:.1f}s bằng giọng {p.name}")
    return {"assets": [a.id]}


# ---------------------------------------------------------------- sửa lời bằng văn bản (F5-TTS speech editing)
def run_retext(state: "EngineState", ctx: JobContext, pid: str, asset_id: str, offset: float, duration: float,
               text: str, keep_duration: bool, language: str | None, seed: int) -> dict:
    from ..registry import pick_tts_model, tts_key
    from ..tts.pipeline import text_language
    from ..tts.text_normalize import normalize

    store = state.edit
    if duration > RETEXT_MAX_SEL:
        raise EngineError("BAD_REQUEST", f"chọn đoạn ngắn hơn {RETEXT_MAX_SEL:.0f} giây để sửa lời")
    asset = store.asset(pid, asset_id)
    if asset.words is None:  # cần lời thoại của phần xung quanh làm ngữ cảnh
        ctx.progress(0.05, "transcribe")
        asset = transcribe_asset(state, pid, asset_id, language or asset.language)
    lang = language if language in ("vi", "en") else (asset.language or text_language(text, "vi"))
    words = asset.words or []
    sel_s, sel_e = offset, offset + duration
    before = [w for w in words if w.end <= sel_s + 0.03 and w.start >= sel_s - RETEXT_BEFORE]
    after = [w for w in words if w.start >= sel_e - 0.03 and w.end <= sel_e + RETEXT_AFTER]
    ctx_s = max(0.0, (before[0].start if before else sel_s) - 0.05)
    ctx_e = min(asset.duration_sec, (after[-1].end if after else sel_e) + 0.05)

    def norm(s: str) -> str:
        return normalize(s, lang).strip()

    prefix, suffix = norm(" ".join(w.text for w in before)), norm(" ".join(w.text for w in after))
    new_text = norm(text)
    if not new_text:
        raise EngineError("BAD_REQUEST", "lời mới trống")
    full_text = " ".join(x for x in (prefix, new_text, suffix) if x)
    if keep_duration:
        new_dur = duration
    else:  # giữ nhịp nói của người trong đoạn: giây trên mỗi byte của phần lời xung quanh
        ctx_bytes = len((prefix + suffix).encode("utf-8"))
        ctx_sec = sum(w.end - w.start for w in before + after)
        rate = ctx_sec / ctx_bytes if ctx_bytes > 10 and ctx_sec > 0.5 else 0.07
        new_dur = float(np.clip(len(new_text.encode("utf-8")) * rate * 1.1, 0.3, 20.0))
    full = store.load(pid, asset_id)
    window = full[int(ctx_s * SR): int(ctx_e * SR)]
    model_id = pick_tts_model(state, lang)
    ctx.progress(0.15, "retext")
    ctx.log(f"Sửa lời ({model_id}): “{text}” · {duration:.2f}s → {new_dur:.2f}s")
    backend = state.models.get(tts_key(state, model_id))
    if not hasattr(backend, "edit"):
        raise EngineError("NOT_IMPLEMENTED", "model TTS này không hỗ trợ sửa lời")
    out = backend.edit(audio_io.resample(window, SR, backend.sample_rate), full_text, sel_s - ctx_s, sel_e - ctx_s,
                       new_dur, seed)
    out = audio_io.resample(out, backend.sample_rate, SR)
    ctx.progress(0.9, "splice")

    a, b = int(round(sel_s * SR)), int(round(sel_e * SR))
    s_i, d_i = int(round((sel_s - ctx_s) * SR)), int(round(new_dur * SR))
    if len(out) < s_i + d_i:
        out = np.pad(out, (0, s_i + d_i - len(out)))
    m = int(SPLICE * SR)
    m_pre = min(m, a, s_i)
    m_post = min(m, len(full) - b, len(out) - (s_i + d_i))
    piece = out[s_i - m_pre: s_i + d_i + m_post].astype(np.float32).copy()
    g_orig, g_new = rms(full[a:b]), rms(out[s_i: s_i + d_i])
    if g_orig > 1e-4 and g_new > 1e-4:  # khớp âm lượng với đoạn cũ
        piece *= float(np.clip(g_orig / g_new, 0.25, 4.0))
    if m_pre:
        r = np.linspace(0.0, 1.0, m_pre, dtype=np.float32)
        piece[:m_pre] = full[a - m_pre: a] * (1 - r) + piece[:m_pre] * r
    if m_post:
        r = np.linspace(0.0, 1.0, m_post, dtype=np.float32)
        piece[len(piece) - m_post:] = piece[len(piece) - m_post:] * (1 - r) + full[b: b + m_post] * r
    new = store.add_asset(pid, piece, SR, f"Sửa lời: {text[:40]}", "retext",
                          words=spread_words(text, m_pre / SR, new_dur), language=lang)
    return {"assets": [new.id], "replaceOffset": round((a - m_pre) / SR, 4),
            "replaceDuration": round((b + m_post - (a - m_pre)) / SR, 4)}


# ---------------------------------------------------------------- dựa trên timeline: khoảng lặng, ducking, xuất file
def _loader(state: "EngineState", pid: str):
    return lambda aid: state.edit.load(pid, aid)


def run_silences(state: "EngineState", ctx: JobContext, pid: str, t: EditTimeline, track_ids: list[str] | None,
                 threshold_db: float, min_sec: float, pad_before: float = 0.25, pad_after: float = 0.25) -> dict:
    ctx.progress(0.1, "analyze")
    mix = dsp.render(t, _loader(state, pid), SR, track_ids)
    ranges = dsp.find_silences(mix, SR, threshold_db, min_sec, pad_before, pad_after)
    ctx.log(f"Tìm thấy {len(ranges)} khoảng lặng dài · tổng {sum(e - s for s, e in ranges):.1f}s")
    return {"ranges": [[s, e] for s, e in ranges]}


def run_duck(state: "EngineState", ctx: JobContext, pid: str, t: EditTimeline, music_ids: list[str], voice_ids: list[str],
             amount_db: float) -> dict:
    load = _loader(state, pid)
    ctx.progress(0.1, "duck")
    voice = dsp.render(t, load, SR, voice_ids, start=0.0, respect_mute=False)
    out: dict[str, str] = {}
    for tid in music_ids:
        tr = next((x for x in t.tracks if x.id == tid), None)
        if tr is None:
            continue
        music = dsp.render(t.model_copy(update={"tracks": [tr.model_copy(update={"gain_db": 0.0, "mute": False, "solo": False})]}),
                           load, SR, [tid], start=0.0, respect_mute=False)
        if not music.size:
            continue
        env = dsp.duck_envelope(voice, SR, len(music), amount_db)
        a = state.edit.add_asset(pid, music * env, SR, f"{tr.name} · hạ theo giọng", "duck")
        out[tid] = a.id
    ctx.log(f"Đã hạ nhạc nền {amount_db:.0f} dB khi có giọng · {len(out)} track")
    return {"tracks": out}


def _srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def timeline_words(state: "EngineState", pid: str, t: EditTimeline) -> list[tuple[float, float, str, int | None]]:
    """Mọi từ của các track đang phát, quy về thời gian trên timeline: (bắt đầu, kết thúc, từ, người nói)."""
    tracks = {tr.id for tr in dsp.audible_tracks(t)}
    assets = {a.id: a for a in state.edit.assets(pid)}
    out = []
    for c in t.clips:
        a = assets.get(c.asset_id)
        if c.track_id not in tracks or a is None or not a.words:
            continue
        for w in a.words:
            mid = (w.start + w.end) / 2
            if not (c.offset <= mid < c.offset + c.duration):
                continue
            spk = c.speaker
            if spk is None and a.turns:
                spk = next((tr.speaker for tr in a.turns if tr.start <= mid < tr.end), None)
            out.append((c.start + w.start - c.offset, c.start + w.end - c.offset, w.text, spk))
    return sorted(out)


def build_srt(words: list[tuple[float, float, str, int | None]], names: dict[int, str]) -> str:
    cues: list[list] = []
    for s, e, text, spk in words:
        cur = cues[-1] if cues else None
        if (cur is None or s - cur[1] > 0.8 or spk != cur[3] or len(cur[2]) + len(text) > 42 or e - cur[0] > 6.0
                or re.search(r"[.!?…]$", cur[2])):
            cues.append([s, e, text, spk])
        else:
            cur[1], cur[2] = e, f"{cur[2]} {text}"
    spk = {c[3] for c in cues}
    multi = len(spk) > 1 and spk != {None}  # có từ hai người (kể cả phần chưa gán người nói) mới ghi tên
    lines = []
    for i, (s, e, text, spk) in enumerate(cues, 1):
        label = f"{names.get(spk, f'Người {spk + 1}')}: " if multi and spk is not None else ""
        lines += [str(i), f"{_srt_time(s)} --> {_srt_time(max(e, s + 0.3))}", label + text, ""]
    return "\n".join(lines)


def run_render(state: "EngineState", ctx: JobContext, pid: str, t: EditTimeline, fmt: str | None, target_lufs: float | None,
               srt: bool) -> dict:
    ctx.progress(0.05, "mix")
    mix = dsp.render(t, _loader(state, pid), SR)
    if not mix.size:
        raise EngineError("BAD_REQUEST", "timeline trống")
    if target_lufs is not None:
        mix = dsp.normalize_loudness(mix, SR, target_lufs)
    elif float(np.max(np.abs(mix))) > 0.999:  # nhiều track cộng lại vượt 0 dBFS: chặn đỉnh thay vì để vỡ tiếng
        mix = dsp.limit(mix, SR, -0.3)
    lufs, peak = dsp.loudness(mix, SR), dsp.peak_db(mix)
    result: dict = {"lufs": round(lufs, 1) if math.isfinite(lufs) else None,
                    "peakDb": round(peak, 1) if math.isfinite(peak) else None, "durationSec": round(len(mix) / SR, 3)}
    if fmt is None:  # chỉ đo
        return result
    ctx.progress(0.7, "export")
    out_dir = state.job_dir(ctx.job)
    safe = re.sub(r"[^\w\-]+", "_", t.name, flags=re.UNICODE).strip("_") or "easyvoice"
    path = audio_io.save(out_dir / f"{safe}.{fmt}", mix, SR)
    result["file"] = state.register_file(path, path.name)
    if srt:
        words = timeline_words(state, pid, t)
        if words:
            sp = out_dir / f"{safe}.srt"
            sp.write_text(build_srt(words, {s.id: s.name for s in t.speakers}), encoding="utf-8")
            result["srt"] = state.register_file(sp, sp.name)
    ctx.log(f"Đã xuất {path.name} · {result['durationSec']:.1f}s · {result['lufs']} LUFS")
    return result
