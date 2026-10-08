"""Build faiss index từ đặc trưng ContentVec của dataset (theo train_index của RVC, nhưng Flat thay cho IVF)."""

from __future__ import annotations

from pathlib import Path

import numpy as np


def build_index(feat_dir: Path, out: Path) -> int:
    import faiss

    feats = [np.load(p) for p in sorted(feat_dir.glob("*.npy"))]
    if not feats:
        raise RuntimeError("không có đặc trưng để build index")
    big = np.concatenate(feats, 0).astype(np.float32)
    rng = np.random.default_rng(0)
    big = big[rng.permutation(len(big))]
    if len(big) > 200_000:  # dataset lớn: gom cụm cho gọn như RVC
        from sklearn.cluster import MiniBatchKMeans

        big = MiniBatchKMeans(n_clusters=10_000, batch_size=8192, n_init=3, random_state=0).fit(big).cluster_centers_.astype(np.float32)
    # Flat (không IVF): train IVF chạy OpenMP của faiss — trên macOS xung đột libomp với torch, tiến trình abort.
    # Suy luận tự tìm k láng giềng bằng torch (infer.Index) nên IVF không còn lợi gì về tốc độ.
    index = faiss.IndexFlatL2(big.shape[1])
    for i in range(0, len(big), 8192):
        index.add(big[i: i + 8192])
    faiss.write_index(index, str(out))
    return int(index.ntotal)
