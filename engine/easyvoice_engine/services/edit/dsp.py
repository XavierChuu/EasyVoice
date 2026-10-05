"""Xử lý tín hiệu cho Edit Audio (chỉ numpy/scipy, chạy CPU): trộn timeline, bộ lọc, đo loudness (ITU-R BS.1770),
limiter, nén, tìm khoảng lặng, hạ nhạc nền theo giọng (ducking)."""

from __future__ import annotations

import math
from collections.abc import Callable

import numpy as np

from .store import EditClip, EditTimeline, EditTrack

FilterName = str  # xem FILTERS


# ---------------------------------------------------------------- trộn timeline
def audible_tracks(t: EditTimeline, track_ids: list[str] | None = None) -> list[EditTrack]:
    """Track phát ra tiếng: bỏ track tắt tiếng; có track solo thì chỉ giữ track solo (như lúc nghe trong app)."""
    tracks = [tr for tr in t.tracks if track_ids is None or tr.id in track_ids]
    solo = any(tr.solo and not tr.mute for tr in tracks)
    return [tr for tr in tracks if not tr.mute and (not solo or tr.solo)]


def db_to_gain(db: float) -> float:
    return float(10 ** (db / 20))


def clip_audio(asset: np.ndarray, clip: EditClip, sr: int) -> np.ndarray:
    """Đoạn audio của clip: cắt theo offset/duration, nhân gain, fade tuyến tính (khớp với lúc phát trong app)."""
    a = int(round(clip.offset * sr))
    n = int(round(clip.duration * sr))
    seg = asset[a: a + n].astype(np.float32) * db_to_gain(clip.gain_db)
    if len(seg) < n:
        seg = np.pad(seg, (0, n - len(seg)))
    fi = min(n, int(round(clip.fade_in * sr)))
    fo = min(n, int(round(clip.fade_out * sr)))
    if fi > 0:
        seg[:fi] *= np.linspace(0.0, 1.0, fi, dtype=np.float32)
    if fo > 0:
        seg[n - fo:] *= np.linspace(1.0, 0.0, fo, dtype=np.float32)
    return seg


def render(t: EditTimeline, load: Callable[[str], np.ndarray], sr: int, track_ids: list[str] | None = None,
           start: float = 0.0, end: float | None = None, respect_mute: bool = True) -> np.ndarray:
    """Trộn các track thành một kênh mono ở sr. load(asset_id) trả audio của asset ở sr."""
    tracks = audible_tracks(t, track_ids) if respect_mute else [tr for tr in t.tracks if track_ids is None or tr.id in track_ids]
    ids = {tr.id: tr for tr in tracks}
    clips = [c for c in t.clips if c.track_id in ids]
    stop = end if end is not None else max((c.start + c.duration for c in clips), default=start)
    total = max(0, int(round((stop - start) * sr)))
    out = np.zeros(total, dtype=np.float32)
    cache: dict[str, np.ndarray] = {}
    for c in clips:
        if c.start + c.duration <= start or c.start >= stop:
            continue
        if c.asset_id not in cache:
            cache[c.asset_id] = load(c.asset_id)
        seg = clip_audio(cache[c.asset_id], c, sr) * db_to_gain(ids[c.track_id].gain_db)
        pos = int(round((c.start - start) * sr))
        a, b = max(0, pos), min(total, pos + len(seg))
        if b > a:
            out[a:b] += seg[a - pos: b - pos]
    return out


# ---------------------------------------------------------------- biquad (RBJ Audio EQ Cookbook)
def _biquad(kind: str, f0: float, sr: int, q: float = 0.7071, gain_db: float = 0.0) -> np.ndarray:
    f0 = min(f0, sr * 0.45)
    w0 = 2 * math.pi * f0 / sr
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * q)
    A = 10 ** (gain_db / 40)
    if kind == "highpass":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "lowpass":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "peak":
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif kind in ("lowshelf", "highshelf"):
        sa = 2 * math.sqrt(A) * alpha
        if kind == "lowshelf":
            b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)]
            a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa]
        else:
            b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)]
            a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa]
    else:
        raise ValueError(kind)
    return np.array([b[0] / a[0], b[1] / a[0], b[2] / a[0], 1.0, a[1] / a[0], a[2] / a[0]])


def apply_sos(x: np.ndarray, stages: list[np.ndarray]) -> np.ndarray:
    from scipy.signal import sosfilt

    if not stages:
        return x
    return sosfilt(np.stack(stages), x).astype(np.float32)


EQ_PRESETS: dict[str, list[tuple]] = {
    # Giọng rõ: bỏ ù tần thấp, giảm "đục" quanh 250 Hz, tăng độ rõ 3,5 kHz
    "eq_voice": [("highpass", 80, 0.7071, 0), ("peak", 250, 1.0, -2.5), ("peak", 3500, 1.0, 3.0), ("highshelf", 10000, 0.7071, 1.5)],
    "eq_warm": [("highpass", 50, 0.7071, 0), ("lowshelf", 160, 0.7071, 3.0), ("highshelf", 7000, 0.7071, -2.5)],
    "eq_bright": [("highpass", 70, 0.7071, 0), ("highshelf", 5500, 0.7071, 4.0)],
    "telephone": [("highpass", 300, 0.7071, 0), ("highpass", 300, 0.7071, 0), ("lowpass", 3400, 0.7071, 0),
                  ("lowpass", 3400, 0.7071, 0), ("peak", 1500, 1.2, 4.0)],
}


# ---------------------------------------------------------------- loudness (ITU-R BS.1770-4 / EBU R128)
def _k_weighting(sr: int) -> list[np.ndarray]:
    # Hệ số theo libebur128: cho đúng giá trị chuẩn ở 48 kHz và tính lại được cho sample rate khác.
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = math.tan(math.pi * f0 / sr)
    Vh, Vb = 10 ** (G / 20), (10 ** (G / 20)) ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    shelf = np.array([(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0,
                      1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = math.tan(math.pi * f0 / sr)
    a0 = 1 + K / Q + K * K
    hp = np.array([1.0, -2.0, 1.0, 1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    return [shelf, hp]


def loudness(x: np.ndarray, sr: int) -> float:
    """Integrated loudness (LUFS) của tín hiệu mono. Trả -inf nếu im lặng."""
    if len(x) < int(0.4 * sr):
        x = np.pad(x, (0, int(0.4 * sr) - len(x)))
    y = apply_sos(x.astype(np.float64), _k_weighting(sr)).astype(np.float64)
    block, hop = int(0.4 * sr), int(0.1 * sr)
    sq = np.concatenate([[0.0], np.cumsum(y * y)])
    starts = np.arange(0, len(y) - block + 1, hop)
    z = (sq[starts + block] - sq[starts]) / block
    with np.errstate(divide="ignore"):
        lk = -0.691 + 10 * np.log10(z)
    z = z[lk > -70]
    if z.size == 0:
        return float("-inf")
    rel = -0.691 + 10 * math.log10(z.mean()) - 10
    with np.errstate(divide="ignore"):
        z = z[-0.691 + 10 * np.log10(z) > rel]
    return float(-0.691 + 10 * math.log10(z.mean())) if z.size else float("-inf")


def peak_db(x: np.ndarray) -> float:
    m = float(np.max(np.abs(x))) if x.size else 0.0
    return 20 * math.log10(m) if m > 0 else float("-inf")


def limit(x: np.ndarray, sr: int, ceiling_db: float = -1.0, window_ms: float = 5.0) -> np.ndarray:
    """Limiter đơn giản: hệ số giảm được lấy min trong cửa sổ (nhìn trước) rồi làm mượt → không méo gắt, đỉnh ≤ ceiling."""
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    c = db_to_gain(ceiling_db)
    mag = np.abs(x)
    if not mag.size or mag.max() <= c:
        return x.astype(np.float32)
    g = np.minimum(1.0, c / np.maximum(mag, 1e-9))
    w = max(1, int(sr * window_ms / 1000))
    g = minimum_filter1d(g, size=2 * w + 1)
    g = uniform_filter1d(g, size=w)
    return np.clip(x * g, -c, c).astype(np.float32)


def normalize_loudness(x: np.ndarray, sr: int, target_lufs: float, ceiling_db: float = -1.0) -> np.ndarray:
    cur = loudness(x, sr)
    if not math.isfinite(cur):
        return x
    return limit(x * db_to_gain(target_lufs - cur), sr, ceiling_db)


def compress(x: np.ndarray, sr: int, threshold_db: float = -24.0, ratio: float = 3.0, attack: float = 0.01,
             release: float = 0.15, block_ms: float = 5.0) -> np.ndarray:
    """Nén dải động theo khối 5 ms (bám đường bao RMS với attack/release), tự bù lại âm lượng trung bình."""
    if not x.size:
        return x
    n = max(1, int(sr * block_ms / 1000))
    nb = math.ceil(len(x) / n)
    padded = np.pad(x, (0, nb * n - len(x)))
    rms = np.sqrt(np.mean(padded.reshape(nb, n) ** 2, axis=1) + 1e-12)
    level = 20 * np.log10(rms)
    ka, kr = math.exp(-block_ms / 1000 / attack), math.exp(-block_ms / 1000 / release)
    env = np.empty(nb)
    e = level[0]
    for i, v in enumerate(level):
        k = ka if v > e else kr
        e = k * e + (1 - k) * v
        env[i] = e
    over = np.maximum(0.0, env - threshold_db)
    gain_db = -over * (1 - 1 / ratio)
    centers = (np.arange(nb) + 0.5) * n
    g = 10 ** (np.interp(np.arange(len(x)), centers, gain_db) / 20)
    y = x * g
    before, after = np.sqrt(np.mean(x ** 2)), np.sqrt(np.mean(y ** 2))
    if after > 1e-9:
        y = y * (before / after)
    return limit(y.astype(np.float32), sr, -1.0)


# ---------------------------------------------------------------- bộ lọc áp lên một đoạn
FILTERS = ("denoise", "highpass", "eq_voice", "eq_warm", "eq_bright", "telephone", "compress", "normalize", "loudness")


def apply_filter(name: str, x: np.ndarray, sr: int, amount: float | None = None) -> tuple[np.ndarray, str]:
    """Trả (audio, ghi chú cho log). amount: độ mạnh khử ồn 0..1, tần số cắt (Hz), mức LUFS... tùy bộ lọc."""
    if name == "denoise":
        from ..preprocess.denoise import light_denoise

        strength = float(np.clip(amount if amount is not None else 0.6, 0.1, 1.0))
        y, ok = light_denoise(x, sr, strength)
        return y, f"khử ồn {strength:.0%}" if ok else "chưa cài noisereduce: giữ nguyên"
    if name == "highpass":
        f = float(np.clip(amount or 80.0, 20.0, 1000.0))
        return apply_sos(x, [_biquad("highpass", f, sr), _biquad("highpass", f, sr)]), f"lọc dưới {f:.0f} Hz"
    if name in EQ_PRESETS:
        return apply_sos(x, [_biquad(k, f, sr, q, g) for k, f, q, g in EQ_PRESETS[name]]), name
    if name == "compress":
        return compress(x, sr, threshold_db=float(amount if amount is not None else -24.0)), "nén dải động"
    if name == "normalize":
        target = float(amount if amount is not None else -1.0)
        m = float(np.max(np.abs(x))) if x.size else 0.0
        return (x * (db_to_gain(target) / m) if m > 1e-6 else x).astype(np.float32), f"đỉnh {target:.1f} dBFS"
    if name == "loudness":
        target = float(amount if amount is not None else -16.0)
        return normalize_loudness(x, sr, target), f"{target:.0f} LUFS"
    raise ValueError(name)


# ---------------------------------------------------------------- khoảng lặng, ducking
def frame_db(x: np.ndarray, sr: int, frame_ms: float = 10.0) -> tuple[np.ndarray, int]:
    n = max(1, int(sr * frame_ms / 1000))
    nb = max(1, math.ceil(len(x) / n))
    padded = np.pad(x, (0, nb * n - len(x)))
    rms = np.sqrt(np.mean(padded.reshape(nb, n) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms), n


def find_silences(x: np.ndarray, sr: int, threshold_db: float = -45.0, min_sec: float = 0.8,
                  keep_sec: float = 0.25) -> list[tuple[float, float]]:
    """Khoảng lặng dài hơn min_sec; mỗi bên giữ lại keep_sec để lời không bị cụt. Trả [(bắt đầu, kết thúc)] giây."""
    db, n = frame_db(x, sr)
    silent = db < threshold_db
    out: list[tuple[float, float]] = []
    i = 0
    while i < len(silent):
        if not silent[i]:
            i += 1
            continue
        j = i
        while j < len(silent) and silent[j]:
            j += 1
        s, e = i * n / sr, min(len(x), j * n) / sr
        if e - s >= min_sec:
            a, b = (s + keep_sec if i > 0 else s), (e - keep_sec if j < len(silent) else e)
            if b - a > 0.05:
                out.append((round(a, 3), round(b, 3)))
        i = j
    return out


def duck_envelope(voice: np.ndarray, sr: int, length: int, amount_db: float = -12.0, threshold_db: float = -42.0,
                  hold: float = 0.25, attack: float = 0.08, release: float = 0.5) -> np.ndarray:
    """Hệ số nhân cho nhạc nền: hạ amount_db khi có giọng, trả lại từ từ khi giọng dừng."""
    if len(voice) < length:
        voice = np.pad(voice, (0, length - len(voice)))
    db, n = frame_db(voice[:length], sr)
    active = db > threshold_db
    h = int(hold * 1000 / 10)
    if h > 0 and active.any():
        from scipy.ndimage import maximum_filter1d

        active = maximum_filter1d(active.astype(np.uint8), size=2 * h + 1).astype(bool)
    low = db_to_gain(amount_db)
    target = np.where(active, low, 1.0)
    ka, kr = math.exp(-0.01 / attack), math.exp(-0.01 / release)
    g = np.empty_like(target)
    cur = 1.0
    for i, v in enumerate(target):
        k = ka if v < cur else kr
        cur = k * cur + (1 - k) * v
        g[i] = cur
    centers = (np.arange(len(g)) + 0.5) * n
    return np.interp(np.arange(length), centers, g).astype(np.float32)
