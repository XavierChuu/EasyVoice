"""Nhận diện người nói (diarization) chạy local: tìm đoạn có tiếng nói → cắt cửa sổ 1,5 s → vector đặc trưng giọng
→ gom cụm (agglomerative, cosine; tự đoán số người bằng silhouette nếu không chỉ định) → làm mượt thành lượt nói.

Vector giọng: WavLM-SV (microsoft/wavlm-base-plus-sv, nạp từ thư mục model local qua transformers) nếu đã tải;
chưa tải thì dùng thống kê log-mel (không cần model, chỉ phân biệt tốt các giọng khác hẳn nhau)."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

import numpy as np

SR = 16000
WIN_SEC, HOP_SEC, FRAME_SEC = 1.5, 0.75, 0.1
MAX_WINDOWS = 3000
MIN_SILHOUETTE = 0.12  # dưới mức này coi như chỉ có một người nói


class Embedder(Protocol):
    name: str

    def embed(self, windows: list[np.ndarray]) -> np.ndarray: ...

    def cluster_space(self, emb: np.ndarray) -> np.ndarray:
        """Không gian để gom cụm (cosine)."""
        ...

    def same(self, a: np.ndarray, b: np.ndarray) -> bool:
        """Hai nhóm vector (theo embed) có phải cùng một người không — chặn việc tách nhầm một người làm hai."""
        ...


class WavLMEmbedder:
    name = "wavlm-sv"

    def __init__(self, model_dir: Path | None, device: str) -> None:
        from transformers import WavLMConfig, WavLMForXVector

        model = WavLMForXVector(WavLMConfig()) if model_dir is None else WavLMForXVector.from_pretrained(str(model_dir))
        self.model = model.eval().to(device)
        self.device = device

    def embed(self, windows: list[np.ndarray]) -> np.ndarray:
        import torch

        out = []
        for i in range(0, len(windows), 16):
            batch = windows[i: i + 16]
            n = max(len(w) for w in batch)
            x = np.zeros((len(batch), n), np.float32)
            mask = np.zeros((len(batch), n), np.int64)
            for j, w in enumerate(batch):
                x[j, : len(w)] = (w - w.mean()) / (w.std() + 1e-7)  # như Wav2Vec2FeatureExtractor(do_normalize)
                mask[j, : len(w)] = 1
            with torch.no_grad():
                e = self.model(input_values=torch.from_numpy(x).to(self.device),
                               attention_mask=torch.from_numpy(mask).to(self.device)).embeddings
            out.append(e.float().cpu().numpy())
        return _l2(np.concatenate(out))

    def cluster_space(self, emb: np.ndarray) -> np.ndarray:
        return emb

    def same(self, a: np.ndarray, b: np.ndarray) -> bool:
        ca, cb = a.mean(0), b.mean(0)
        sim = float(ca @ cb / (np.linalg.norm(ca) * np.linalg.norm(cb) + 1e-9))
        return sim > 0.86  # ngưỡng xác minh người nói gợi ý của WavLM-SV


class MelStatsEmbedder:
    """Trung bình + độ lệch log-mel 40 dải (âm sắc, độ trầm bổng trung bình) — dự phòng khi chưa tải model."""

    name = "log-mel"

    def __init__(self) -> None:
        self.fb = _mel_filterbank(40, 512, SR)

    def embed(self, windows: list[np.ndarray]) -> np.ndarray:
        feats = []
        for w in windows:
            if len(w) < 400:
                w = np.pad(w, (0, 400 - len(w)))
            frames = np.lib.stride_tricks.sliding_window_view(w, 400)[::160] * np.hanning(400)
            spec = np.abs(np.fft.rfft(frames, 512)) ** 2
            mel = np.log(spec @ self.fb.T + 1e-8)
            mel = mel[(spec.sum(axis=1) > 1e-6)]  # bỏ khung im lặng hoàn toàn
            if not len(mel):
                mel = np.zeros((1, self.fb.shape[0]))
            mean = mel.mean(0)
            # Đơn vị dB, bỏ mức to/nhỏ chung (không phải đặc điểm của giọng), chỉ giữ hình dạng phổ
            feats.append(np.concatenate([mean - mean.mean(), 0.5 * mel.std(0)]) * (10 / np.log(10)))
        return np.asarray(feats)

    def cluster_space(self, emb: np.ndarray) -> np.ndarray:
        return _l2((emb - emb.mean(0)) / (emb.std(0) + 1e-6))  # chuẩn hóa theo cả tập để cosine so sánh được

    def same(self, a: np.ndarray, b: np.ndarray) -> bool:
        return float(np.sqrt(np.mean((a.mean(0) - b.mean(0)) ** 2))) < 2.0  # khác nhau trung bình < 2 dB


def _l2(x: np.ndarray) -> np.ndarray:
    return x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)


def _mel_filterbank(n_mels: int, n_fft: int, sr: int) -> np.ndarray:
    def hz2mel(f):
        return 2595 * np.log10(1 + f / 700)

    def mel2hz(m):
        return 700 * (10 ** (m / 2595) - 1)

    pts = mel2hz(np.linspace(hz2mel(60), hz2mel(sr / 2 - 200), n_mels + 2))
    bins = np.floor((n_fft + 1) * pts / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for m in range(1, n_mels + 1):
        a, c, b = bins[m - 1], bins[m], bins[m + 1]
        for k in range(a, c):
            fb[m - 1, k] = (k - a) / max(1, c - a)
        for k in range(c, b):
            fb[m - 1, k] = (b - k) / max(1, b - c)
    return fb


def voiced_regions(x: np.ndarray, sr: int = SR, gap: float = 0.3, min_len: float = 0.3) -> list[tuple[float, float]]:
    """Đoạn có tiếng nói theo năng lượng (khung 20 ms, ngưỡng tương đối so với phần to nhất)."""
    n = int(0.02 * sr)
    nb = len(x) // n
    if nb == 0:
        return []
    rms = np.sqrt(np.mean(x[: nb * n].reshape(nb, n) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    thr = max(-55.0, float(np.percentile(db, 95)) - 35)
    active = db > thr
    regions: list[list[float]] = []
    for i, a in enumerate(active):
        if not a:
            continue
        t = i * 0.02
        if regions and t - regions[-1][1] <= gap:
            regions[-1][1] = t + 0.02
        else:
            regions.append([t, t + 0.02])
    return [(s, e) for s, e in regions if e - s >= min_len]


def _windows(regions: list[tuple[float, float]], hop: float) -> list[tuple[float, float]]:
    out = []
    for s, e in regions:
        if e - s <= WIN_SEC:
            out.append((s, e))
            continue
        t = s
        while t + WIN_SEC <= e + 1e-6:
            out.append((t, t + WIN_SEC))
            t += hop
        if out[-1][1] < e - 0.3:
            out.append((e - WIN_SEC, e))
    return out


def cluster(raw: np.ndarray, embedder: Embedder, num_speakers: int | None = None) -> np.ndarray:
    n = len(raw)
    if n < 2 or num_speakers == 1:
        return np.zeros(n, dtype=int)
    embs = embedder.cluster_space(raw)
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics import silhouette_score

    def fit(k: int) -> np.ndarray:
        return AgglomerativeClustering(n_clusters=k, metric="cosine", linkage="average").fit_predict(embs)

    if num_speakers:
        return fit(min(num_speakers, n))
    best, best_s = np.zeros(n, dtype=int), MIN_SILHOUETTE
    for k in range(2, min(8, n - 1) + 1):
        labels = fit(k)
        if len(set(labels)) < 2:
            continue
        s = float(silhouette_score(embs, labels, metric="cosine"))
        if s > best_s + 0.02:  # ưu tiên ít người hơn khi điểm gần bằng nhau
            best, best_s = labels, s
    # Gộp các cụm thực ra cùng một giọng (vd. một người lúc to lúc nhỏ bị tách đôi)
    while True:
        ids = sorted(set(best.tolist()))
        pair = next(((i, j) for k, i in enumerate(ids) for j in ids[k + 1:] if embedder.same(raw[best == i], raw[best == j])), None)
        if pair is None:
            break
        best = np.where(best == pair[1], pair[0], best)
    return best


def _turns(regions, windows, labels, min_turn: float = 0.5) -> list[tuple[float, float, int]]:
    """Gán nhãn từng khung 0,1 s theo cửa sổ gần nhất, lọc đa số 5 khung, gộp thành lượt nói."""
    if not windows:
        return []
    centers = np.array([(s + e) / 2 for s, e in windows])
    frames: list[tuple[float, int]] = []
    for s, e in regions:
        t = s
        while t < e:
            c = t + FRAME_SEC / 2
            frames.append((t, int(labels[int(np.argmin(np.abs(centers - c)))])))
            t += FRAME_SEC
    if not frames:
        return []
    lab = np.array([f[1] for f in frames])
    smooth = lab.copy()
    for i in range(len(lab)):
        win = lab[max(0, i - 2): i + 3]
        smooth[i] = np.bincount(win).argmax()
    turns: list[list] = []
    for (t, _), lb in zip(frames, smooth):
        end = t + FRAME_SEC
        if turns and turns[-1][2] == lb and t - turns[-1][1] < 0.6:
            turns[-1][1] = end
        else:
            turns.append([t, end, int(lb)])
    # Lượt quá ngắn (vd. "ừ" chen giữa) gộp vào lượt trước nếu khác người — tránh vụn
    merged: list[list] = []
    for tr in turns:
        if merged and tr[1] - tr[0] < min_turn and tr[0] - merged[-1][1] < 0.6:
            merged[-1][1] = tr[1]
        elif merged and merged[-1][2] == tr[2] and tr[0] - merged[-1][1] < 0.6:
            merged[-1][1] = tr[1]
        else:
            merged.append(tr)
    return [(round(s, 2), round(e, 2), lb) for s, e, lb in merged]


def diarize(items: list[tuple[str, np.ndarray]], embedder: Embedder, num_speakers: int | None = None,
            on_progress=None) -> tuple[dict[str, list[tuple[float, float, int]]], int]:
    """items: [(khóa, audio 16 kHz)]. Gom cụm chung mọi item để cùng một người có cùng nhãn ở mọi đoạn.
    Trả ({khóa: [(bắt đầu, kết thúc, người)]}, số người). Nhãn đánh số theo thứ tự xuất hiện."""
    per: list[tuple[str, list, list]] = []
    total_dur = sum(len(a) for _, a in items) / SR
    hop = max(HOP_SEC, total_dur / MAX_WINDOWS)
    for key, audio in items:
        regions = voiced_regions(audio)
        per.append((key, regions, _windows(regions, hop)))
    clips = [audio[int(s * SR): int(e * SR)] for (_, audio), (_, _, wins) in zip(items, per) for s, e in wins]
    if not clips:
        return {key: [] for key, _ in items}, 0
    embs = []
    for i in range(0, len(clips), 64):
        embs.append(embedder.embed(clips[i: i + 64]))
        if on_progress:
            on_progress(min(1.0, (i + 64) / len(clips)) * 0.9)
    labels = cluster(np.concatenate(embs), embedder, num_speakers)
    out: dict[str, list[tuple[float, float, int]]] = {}
    k = 0
    for key, regions, wins in per:
        out[key] = _turns(regions, wins, labels[k: k + len(wins)])
        k += len(wins)
    order: dict[int, int] = {}
    for key, _ in items:
        for _, _, lb in out[key]:
            order.setdefault(lb, len(order))
    out = {key: [(s, e, order[lb]) for s, e, lb in v] for key, v in out.items()}
    return out, len(order)
