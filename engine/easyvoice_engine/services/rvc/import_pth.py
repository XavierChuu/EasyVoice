"""Nhập model RVC .pth cộng đồng an toàn (spec 3.5): torch.load(weights_only=True) trong PROCESS RIÊNG,
convert sang safetensors. File chứa code object (pickle độc) bị chặn, không import gì."""

from __future__ import annotations

import json
import multiprocessing as mp
import shutil
from pathlib import Path

from ...core.errors import EngineError


def _child(pth: str, out_dir: str, q) -> None:  # chạy trong process riêng
    try:
        import pickle

        import torch
        from safetensors.torch import save_file

        try:
            cpt = torch.load(pth, map_location="cpu", weights_only=True)
        except (pickle.UnpicklingError, RuntimeError, AttributeError, TypeError) as exc:
            q.put(("unsafe", str(exc)[:300]))
            return
        if not isinstance(cpt, dict) or "weight" not in cpt or "config" not in cpt:
            q.put(("bad", "không phải model RVC (thiếu weight/config)"))
            return
        weights = {k: v.contiguous() for k, v in cpt["weight"].items() if hasattr(v, "contiguous")}
        config = list(cpt["config"])
        config[-3] = int(weights["emb_g.weight"].shape[0])
        version = cpt.get("version", "v1")
        if version != "v2":
            q.put(("bad", f"chỉ hỗ trợ RVC v2 (model là {version})"))
            return
        out = Path(out_dir)
        save_file(weights, str(out / "model.safetensors"))
        meta = {"config": config, "f0": int(cpt.get("f0", 1)), "version": version, "sr": int(config[-1])}
        (out / "rvc.json").write_text(json.dumps(meta), encoding="utf-8")
        q.put(("ok", meta))
    except Exception as exc:  # noqa: BLE001
        q.put(("bad", f"{type(exc).__name__}: {exc}"[:300]))


def convert_pth(pth: Path, out_dir: Path, timeout: float = 120.0) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    proc = ctx.Process(target=_child, args=(str(pth), str(out_dir), q), daemon=True)
    proc.start()
    proc.join(timeout)
    if proc.is_alive():
        proc.kill()
        raise EngineError("BAD_FILE", "quá thời gian đọc model")
    if q.empty():
        raise EngineError("BAD_FILE", f"process đọc model thoát với mã {proc.exitcode}")
    status, payload = q.get()
    if status == "unsafe":
        shutil.rmtree(out_dir, ignore_errors=True)
        raise EngineError("UNSAFE_MODEL", payload)
    if status != "ok":
        shutil.rmtree(out_dir, ignore_errors=True)
        raise EngineError("BAD_FILE", payload)
    return payload
