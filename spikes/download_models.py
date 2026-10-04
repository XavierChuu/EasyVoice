"""Tải model cho spike theo models.spike.json: tải tiếp khi rớt mạng (HTTP Range), kiểm sha256 nếu đã có.

  python download_models.py                 # nhóm rvc + tts
  python download_models.py --group rvc
  python download_models.py --group tts-base

Repo gated trên Hugging Face: đặt biến môi trường HF_TOKEN.
Checkpoint F5-TTS tiếng Việt KHÔNG nằm trong danh sách — chọn và tải tay (xem README, mục "Checkpoint tiếng Việt").
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import urllib.request
from pathlib import Path

from common import MODELS_DIR, SPIKES_DIR

CHUNK = 1 << 20


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(url, headers={"User-Agent": "easyvoice-spike"})
    if have:
        req.add_header("Range", f"bytes={have}-")
    token = os.environ.get("HF_TOKEN")
    if token and "huggingface.co" in url:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req) as resp:
        if have and resp.status != 206:  # server không hỗ trợ Range → tải lại từ đầu
            have = 0
        total = int(resp.headers.get("Content-Length", 0)) + have
        mode = "ab" if have else "wb"
        done = have
        with part.open(mode) as f:
            while block := resp.read(CHUNK):
                f.write(block)
                done += len(block)
                if total:
                    print(f"\r  {done / 1e6:8.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    part.replace(dest)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--group", nargs="+", default=["rvc", "tts"])
    ap.add_argument("--manifest", default=str(SPIKES_DIR / "models.spike.json"))
    args = ap.parse_args()

    entries = json.loads(Path(args.manifest).read_text(encoding="utf-8"))["models"]
    for m in entries:
        if m["group"] not in args.group:
            continue
        dest = MODELS_DIR / m["dest"]
        if dest.exists():
            print(f"[có sẵn] {m['id']} → {dest}")
        else:
            print(f"[tải] {m['id']} ← {m['url']}")
            download(m["url"], dest)
        digest = sha256_of(dest)
        if m.get("sha256") and m["sha256"] != digest:
            dest.unlink()
            raise SystemExit(f"Sai sha256 cho {m['id']}: {digest} ≠ {m['sha256']} — đã xóa file")
        print(f"  sha256 {digest}  license: {m['license']}")


if __name__ == "__main__":
    main()
