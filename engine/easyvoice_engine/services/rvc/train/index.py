"""Build faiss index từ đặc trưng ContentVec của dataset (theo train_index của RVC: IVF + Flat)."""

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
    n_ivf = min(int(16 * np.sqrt(len(big))), len(big) // 39)
    if n_ivf >= 1:
        index = faiss.index_factory(big.shape[1], f"IVF{n_ivf},Flat")
        ivf = faiss.extract_index_ivf(index)
        ivf.nprobe = 1
        index.train(big)
        for i in range(0, len(big), 8192):
            index.add(big[i: i + 8192])
        ivf.make_direct_map()  # để lúc suy luận reconstruct_n được
    else:  # dataset rất nhỏ
        index = faiss.IndexFlatL2(big.shape[1])
        index.add(big)
    faiss.write_index(index, str(out))
    return int(index.ntotal)
