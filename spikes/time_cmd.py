"""Bấm giờ một lệnh bất kỳ (dùng để đo thời gian train RVC bằng công cụ ngoài trong Phase 0).

Ghi lại: thời gian chạy, VRAM đỉnh (nvidia-smi, nếu có), RAM đỉnh của cây process (psutil, nếu có),
tổng thời lượng dataset (nếu truyền --dataset).

Ví dụ (mọi thứ sau "--" là lệnh cần đo):
  python time_cmd.py --label preprocess --dataset data/giong_10phut -- python core.py preprocess ...
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import threading
import time
from pathlib import Path

from common import Results

AUDIO_EXT = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}


def dataset_seconds(path: Path) -> float:
    import soundfile as sf

    total = 0.0
    for f in path.rglob("*"):
        if f.suffix.lower() in AUDIO_EXT:
            try:
                total += sf.info(str(f)).duration
            except Exception:  # noqa: BLE001 — mp3/m4a có thể không đọc được bằng soundfile
                import librosa

                total += librosa.get_duration(path=str(f))
    return total


def gpu_used_mb() -> float | None:
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        return max(float(x) for x in out.split())
    except Exception:  # noqa: BLE001
        return None


def tree_rss_mb(pid: int) -> float | None:
    try:
        import psutil
    except ImportError:
        return None
    try:
        p = psutil.Process(pid)
        procs = [p, *p.children(recursive=True)]
        return sum(x.memory_info().rss for x in procs) / 1024 / 1024
    except Exception:  # noqa: BLE001
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", required=True, help="tên bước, vd. preprocess / extract / train-can-bang / index")
    ap.add_argument("--dataset", help="thư mục audio để tính tổng thời lượng")
    ap.add_argument("--cwd", help="thư mục chạy lệnh (vd. thư mục Applio)")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    if not cmd:
        ap.error("thiếu lệnh sau --")

    baseline = gpu_used_mb()
    peaks = {"gpu": baseline or 0.0, "rss": 0.0}
    t0 = time.perf_counter()
    proc = subprocess.Popen(cmd, cwd=args.cwd)

    def poll() -> None:
        while proc.poll() is None:
            g = gpu_used_mb()
            r = tree_rss_mb(proc.pid)
            if g is not None:
                peaks["gpu"] = max(peaks["gpu"], g)
            if r is not None:
                peaks["rss"] = max(peaks["rss"], r)
            time.sleep(1)

    th = threading.Thread(target=poll, daemon=True)
    th.start()
    code = proc.wait()
    elapsed = time.perf_counter() - t0
    th.join(timeout=2)

    res = Results(f"time_{args.label}", "n/a", params={"cmd": cmd, "cwd": args.cwd, "dataset": args.dataset})
    res.metrics = {
        "exit_code": code,
        "seconds": elapsed,
        "minutes": elapsed / 60,
        "gpu_used_peak_mb": peaks["gpu"] or None,
        "gpu_used_baseline_mb": baseline,
        "rss_peak_mb": peaks["rss"] or None,
    }
    if args.dataset:
        res.metrics["dataset_minutes"] = dataset_seconds(Path(args.dataset)) / 60
    res.notes.append("VRAM đo bằng nvidia-smi là của cả GPU (gồm app khác); trừ baseline để ước lượng")
    print(f"\n[{args.label}] exit={code}  {elapsed / 60:.1f} phút  VRAM đỉnh {peaks['gpu'] or '-'} MB")
    res.save()


if __name__ == "__main__":
    main()
