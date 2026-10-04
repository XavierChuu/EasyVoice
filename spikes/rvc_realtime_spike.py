"""Spike Phase 0 — RVC real-time tối giản: micro → model → loa, chạy hoàn toàn trong Python bằng sounddevice.

Ba chế độ:
  --list-devices          liệt kê thiết bị, phát hiện VB-Cable (Windows) / BlackHole (macOS)
  --bench-input FILE      không cần thiết bị âm thanh: đẩy file qua đúng vòng xử lý theo từng block,
                          đo thời gian xử lý mỗi block ở các block size (mặc định 100/160/250 ms), ghi file output
  (mặc định) live         mở micro/loa thật, đổi giọng trực tiếp, in VU meter, thời gian xử lý, underrun
  --roundtrip             đo độ trễ thiết bị (vòng loa → micro) bằng xung click; cần nối dây out→in
                          hoặc để micro sát loa. Cộng với độ trễ thuật toán ra độ trễ end-to-end.

Thuật toán theo gui_v1.py của RVC: buffer = ngữ cảnh + crossfade + vùng tìm SOLA + block; mỗi block chạy
model trên cả buffer nhưng chỉ giải mã phần đuôi; ghép bằng SOLA (tìm độ lệch có tương quan cao nhất) + crossfade.

Ví dụ:
  python rvc_realtime_spike.py --bench-input samples/giong_noi.wav --model models/rvc/voice.pth
  python rvc_realtime_spike.py --model models/rvc/voice.pth --input-device 1 --output-device 3 --duration 1800
  python rvc_realtime_spike.py --dummy --bench-input samples/giong_noi.wav
"""

from __future__ import annotations

import argparse
import queue
import sys
import threading
import time
from dataclasses import dataclass, field

import numpy as np
import torch
import torch.nn.functional as F

from common import (
    MODELS_DIR, OUT_DIR, Results, load_audio, memory_snapshot, percentiles, pick_device,
    reset_peak_memory, sync,
)
from rvc_core import HOP_16K, SR_16K, ConvertParams, RVCConverter

PRESETS = {  # spec 3.4: "Độ trễ thấp / Cân bằng / Chất lượng"
    "low-latency": {"block_ms": 100, "context_s": 1.0, "crossfade_ms": 40},
    "balanced": {"block_ms": 160, "context_s": 1.5, "crossfade_ms": 60},
    "quality": {"block_ms": 250, "context_s": 2.0, "crossfade_ms": 80},
}

VIRTUAL_DEVICE_HINTS = ("cable", "vb-audio", "blackhole")


@dataclass
class RealtimeConfig:
    sr: int = 48000  # sample rate của thiết bị
    block_ms: float = 160
    context_s: float = 1.5
    crossfade_ms: float = 60
    gate_db: float = -60.0  # noise gate: block có RMS dưới ngưỡng coi như im lặng
    params: ConvertParams = field(default_factory=ConvertParams)


class RealtimeVC:
    """Xử lý từng block ở sample rate thiết bị. Dùng chung cho chế độ live và bench."""

    def __init__(self, conv: RVCConverter, cfg: RealtimeConfig):
        import torchaudio

        if cfg.sr % 100:
            raise ValueError("sample rate thiết bị phải chia hết cho 100")
        self.conv, self.cfg = conv, cfg
        self.device = conv.device
        zc = cfg.sr // 100  # số mẫu trong 10 ms
        self.zc = zc
        self.block = max(1, round(cfg.block_ms / 10)) * zc
        crossfade = max(1, round(cfg.crossfade_ms / 10)) * zc
        self.sola_buffer = min(crossfade, 4 * zc)
        self.sola_search = zc
        self.context = round(cfg.context_s * 100) * zc
        self.total = self.context + self.sola_buffer + self.sola_search + self.block
        self.return_frames = (self.block + self.sola_buffer + self.sola_search) // zc

        self.input_buf = torch.zeros(self.total, device=self.device)
        self.sola_prev = torch.zeros(self.sola_buffer, device=self.device)
        t = torch.linspace(0, 1, self.sola_buffer, device=self.device)
        self.fade_in = torch.sin(0.5 * np.pi * t) ** 2
        self.fade_out = 1 - self.fade_in
        self.to16k = torchaudio.transforms.Resample(cfg.sr, SR_16K).to(self.device)
        self.from_model = torchaudio.transforms.Resample(conv.tgt_sr, cfg.sr).to(self.device)

    @property
    def algorithmic_latency_s(self) -> float:
        """Độ trễ do thuật toán thêm vào (ngoài buffer của thiết bị): đầu ra chậm hơn đầu vào cỡ
        sola_buffer + sola_search. Block size ảnh hưởng qua buffer thiết bị (đo bằng --roundtrip)."""
        return (self.sola_buffer + self.sola_search) / self.cfg.sr

    @torch.no_grad()
    def process(self, block_in: np.ndarray) -> np.ndarray:
        x = torch.from_numpy(block_in.astype(np.float32)).to(self.device)
        rms_db = 20 * torch.log10(torch.sqrt(torch.mean(x * x)) + 1e-9)
        if rms_db < self.cfg.gate_db:
            x = torch.zeros_like(x)
        self.input_buf = torch.cat([self.input_buf[self.block:], x])

        audio16k = self.to16k(self.input_buf.unsqueeze(0))[0]
        y = self.conv.convert(audio16k.cpu().numpy(), self.cfg.params, return_frames=self.return_frames)
        y = self.from_model(torch.from_numpy(y).to(self.device).unsqueeze(0))[0]
        need = self.block + self.sola_buffer + self.sola_search
        if y.shape[0] < need:
            y = F.pad(y, (need - y.shape[0], 0))
        y = y[-need:]

        # SOLA: tìm độ lệch trong vùng search để nối liền mạch với đuôi block trước.
        head = y[: self.sola_buffer + self.sola_search]
        nom = F.conv1d(head[None, None], self.sola_prev[None, None])
        den = torch.sqrt(
            F.conv1d(head[None, None] ** 2, torch.ones(1, 1, self.sola_buffer, device=self.device)) + 1e-8
        )
        offset = int(torch.argmax(nom[0, 0] / den[0, 0]))
        y = y[offset:]
        y[: self.sola_buffer] = y[: self.sola_buffer] * self.fade_in + self.sola_prev * self.fade_out
        self.sola_prev = y[self.block: self.block + self.sola_buffer].clone()
        return y[: self.block].cpu().numpy()


def db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(np.square(x))) + 1e-9))


def build_converter(args) -> RVCConverter:
    device = pick_device(args.device)
    half = device.startswith("cuda") and not args.fp32
    return RVCConverter(
        None if args.dummy else args.model,
        None if args.dummy else args.hubert,
        None if args.dummy else args.rmvpe,
        None if args.dummy else args.index,
        device, half,
    )


def make_config(args, block_ms: float, sr: int) -> RealtimeConfig:
    preset = PRESETS[args.preset] if args.preset else {}
    return RealtimeConfig(
        sr=sr,
        block_ms=block_ms,
        context_s=args.context_s if args.context_s is not None else preset.get("context_s", 1.5),
        crossfade_ms=args.crossfade_ms if args.crossfade_ms is not None else preset.get("crossfade_ms", 60),
        gate_db=args.gate_db,
        params=ConvertParams(args.pitch, args.index_rate, args.protect),
    )


def run_bench(args) -> None:
    import soundfile as sf

    conv = build_converter(args)
    device = conv.device
    sr = args.sr or 48000
    audio = load_audio(args.bench_input, sr)
    res = Results("rvc_realtime_bench", device, params={k: v for k, v in vars(args).items()})
    res.metrics["model_sr"] = conv.tgt_sr
    blocks = args.block_ms or ([PRESETS[args.preset]["block_ms"]] if args.preset else [100, 160, 250])
    for block_ms in blocks:
        reset_peak_memory(device)
        rt = RealtimeVC(conv, make_config(args, block_ms, sr))
        n_blocks = len(audio) // rt.block
        out = np.zeros(n_blocks * rt.block, dtype=np.float32)
        times: list[float] = []
        for i in range(n_blocks):
            chunk = audio[i * rt.block: (i + 1) * rt.block]
            sync(device)
            t0 = time.perf_counter()
            out[i * rt.block: (i + 1) * rt.block] = rt.process(chunk)
            sync(device)
            times.append((time.perf_counter() - t0) * 1000)
        measured = times[args.warmup_blocks:] or times
        budget = rt.block / sr * 1000
        late = sum(t > budget for t in measured)
        stats = percentiles(measured)
        res.metrics[f"block_{block_ms:g}ms"] = {
            "block_ms": budget,
            "context_s": rt.cfg.context_s,
            "crossfade_ms": rt.sola_buffer / sr * 1000,
            "process_ms": stats,
            "load_ratio_p95": stats["p95"] / budget,
            "blocks": len(measured),
            "late_blocks": late,
            "algorithmic_latency_ms": rt.algorithmic_latency_s * 1000,
            "memory": memory_snapshot(device),
        }
        path = OUT_DIR / f"rvc_rt_bench_{block_ms:g}ms.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(path, out, sr)
        print(
            f"block {budget:.0f} ms: xử lý mean {stats['mean']:.1f} / p95 {stats['p95']:.1f} / max {stats['max']:.1f} ms,"
            f" trễ hạn {late}/{len(measured)} block → {path}"
        )
    if args.dummy:
        res.notes.append("dummy: trọng số ngẫu nhiên — chỉ kiểm tra đường code")
    res.notes.append("bench không gồm buffer thiết bị; đo độ trễ thật bằng --roundtrip")
    res.save()


def list_devices() -> None:
    import sounddevice as sd

    print(sd.query_devices())
    found = [d["name"] for d in sd.query_devices() if any(h in d["name"].lower() for h in VIRTUAL_DEVICE_HINTS)]
    if found:
        print("\nThiết bị ảo phát hiện được:", ", ".join(sorted(set(found))))
    else:
        print("\nChưa thấy thiết bị ảo. Windows: VB-Cable https://vb-audio.com/Cable/ ;"
              " macOS: BlackHole https://existential.audio/blackhole/")


def run_live(args) -> None:
    import sounddevice as sd

    conv = build_converter(args)
    device = conv.device
    in_dev = args.input_device if args.input_device is not None else sd.default.device[0]
    sr = args.sr or int(sd.query_devices(in_dev)["default_samplerate"])
    block_ms = (args.block_ms or [PRESETS[args.preset]["block_ms"] if args.preset else 160])[0]
    rt = RealtimeVC(conv, make_config(args, block_ms, sr))
    budget_ms = rt.block / sr * 1000

    # Warmup để lần chạy đầu (cấp phát GPU, cuDNN autotune) không tính vào underrun.
    for _ in range(5):
        rt.process(np.zeros(rt.block, dtype=np.float32))

    stats = {"proc": [], "late": 0, "in_overflow": 0, "out_underflow": 0, "callbacks": 0}
    meters: queue.Queue[tuple[float, float]] = queue.Queue(maxsize=100)
    lock = threading.Lock()

    def callback(indata, outdata, frames, _time, status):
        t0 = time.perf_counter()
        y = rt.process(indata[:, 0].copy())
        outdata[:] = np.repeat(y[:, None], outdata.shape[1], axis=1)
        ms = (time.perf_counter() - t0) * 1000
        with lock:
            stats["callbacks"] += 1
            stats["proc"].append(ms)
            stats["late"] += ms > budget_ms
            stats["in_overflow"] += bool(status.input_overflow)
            stats["out_underflow"] += bool(status.output_underflow)
        try:
            meters.put_nowait((db(indata[:, 0]), db(y)))
        except queue.Full:
            pass

    reset_peak_memory(device)
    res = Results("rvc_realtime_live", device, params={k: v for k, v in vars(args).items()})
    with sd.Stream(
        device=(in_dev, args.output_device), samplerate=sr, blocksize=rt.block, dtype="float32",
        channels=(1, args.out_channels), callback=callback, latency=args.latency,
    ) as stream:
        in_lat, out_lat = stream.latency
        est = in_lat + out_lat + rt.block / sr + rt.algorithmic_latency_s
        print(f"sr={sr} block={budget_ms:.0f}ms  độ trễ thiết bị in/out = {in_lat * 1000:.0f}/{out_lat * 1000:.0f} ms,"
              f" ước tính end-to-end ≈ {est * 1000:.0f} ms. Ctrl+C để dừng.")
        t_end = time.time() + args.duration if args.duration else None
        last = time.time()
        try:
            while t_end is None or time.time() < t_end:
                time.sleep(0.2)
                if time.time() - last >= 5:
                    last = time.time()
                    vin = vout = -120.0
                    while not meters.empty():
                        vin, vout = meters.get_nowait()
                    with lock:
                        recent = stats["proc"][-int(5000 / budget_ms):]
                        p = percentiles(recent)
                        print(f"  VU in {vin:6.1f} dB | out {vout:6.1f} dB | xử lý p95 {p.get('p95', 0):5.1f} ms"
                              f" / {budget_ms:.0f} ms | trễ hạn {stats['late']} | underflow {stats['out_underflow']}"
                              f" | overflow {stats['in_overflow']}")
        except KeyboardInterrupt:
            pass
    with lock:
        res.metrics = {
            "sr": sr,
            "block_ms": budget_ms,
            "device_latency_ms": {"input": in_lat * 1000, "output": out_lat * 1000},
            "estimated_e2e_ms": est * 1000,
            "algorithmic_latency_ms": rt.algorithmic_latency_s * 1000,
            "process_ms": percentiles(stats["proc"]),
            "callbacks": stats["callbacks"],
            "late_blocks": stats["late"],
            "output_underflow": stats["out_underflow"],
            "input_overflow": stats["in_overflow"],
            "memory": memory_snapshot(device),
        }
    res.save()


def run_roundtrip(args) -> None:
    """Phát xung click ra loa, thu bằng micro, đo độ trễ vòng thiết bị với cùng block size."""
    import sounddevice as sd

    in_dev = args.input_device if args.input_device is not None else sd.default.device[0]
    sr = args.sr or int(sd.query_devices(in_dev)["default_samplerate"])
    block_ms = (args.block_ms or [160])[0]
    block = round(block_ms / 10) * (sr // 100)
    period = sr  # 1 click mỗi giây
    clicks = 8
    total = period * (clicks + 1)
    played = np.zeros(total, dtype=np.float32)
    for k in range(clicks):
        played[(k + 1) * period: (k + 1) * period + 48] = 0.8
    recorded = np.zeros(total, dtype=np.float32)
    pos = {"i": 0}

    def callback(indata, outdata, frames, _time, _status):
        i = pos["i"]
        n = min(frames, total - i)
        outdata[:] = 0
        if n > 0:
            outdata[:n] = played[i: i + n, None]
            recorded[i: i + n] = indata[:n, 0]
        pos["i"] = i + frames

    with sd.Stream(device=(in_dev, args.output_device), samplerate=sr, blocksize=block, dtype="float32",
                   channels=(1, args.out_channels), callback=callback, latency=args.latency):
        sd.sleep(int(total / sr * 1000) + 500)

    lags = []
    for k in range(clicks):
        start = (k + 1) * period
        seg = np.abs(recorded[start: start + period])
        if seg.max() < 0.05:
            continue
        lags.append(int(np.argmax(seg > 0.5 * seg.max())) / sr * 1000)
    res = Results("rvc_realtime_roundtrip", "n/a", params={k: v for k, v in vars(args).items()})
    if not lags:
        print("Không bắt được xung — kiểm tra dây nối out→in / âm lượng.")
        res.notes.append("không bắt được xung")
    else:
        p = percentiles(lags)
        print(f"Độ trễ vòng thiết bị (block {block_ms} ms): median {p['p50']:.1f} ms, max {p['max']:.1f} ms")
        print("End-to-end ≈ số này + độ trễ thuật toán (crossfade + SOLA, xem kết quả bench).")
        res.metrics = {"sr": sr, "block_ms": block_ms, "roundtrip_ms": p, "detected": len(lags)}
    res.save()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--bench-input", help="file audio để bench không cần thiết bị")
    ap.add_argument("--roundtrip", action="store_true", help="đo độ trễ vòng thiết bị")
    ap.add_argument("--model", help="RVC v2 .pth")
    ap.add_argument("--index")
    ap.add_argument("--hubert", default=str(MODELS_DIR / "content-vec-best"))
    ap.add_argument("--rmvpe", default=str(MODELS_DIR / "rmvpe.pt"))
    ap.add_argument("--dummy", action="store_true")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--fp32", action="store_true")
    ap.add_argument("--preset", choices=sorted(PRESETS))
    ap.add_argument("--block-ms", type=float, nargs="+", help="một hoặc nhiều block size (bench chạy lần lượt)")
    ap.add_argument("--context-s", type=float)
    ap.add_argument("--crossfade-ms", type=float)
    ap.add_argument("--gate-db", type=float, default=-60.0)
    ap.add_argument("--pitch", type=float, default=0.0)
    ap.add_argument("--index-rate", type=float, default=0.0, help="real-time mặc định tắt index cho nhanh")
    ap.add_argument("--protect", type=float, default=0.33)
    ap.add_argument("--sr", type=int, help="sample rate thiết bị (mặc định theo thiết bị / 48000 khi bench)")
    ap.add_argument("--input-device", type=int)
    ap.add_argument("--output-device", type=int)
    ap.add_argument("--out-channels", type=int, default=2)
    ap.add_argument("--latency", default="low", help="'low', 'high' hoặc số giây cho PortAudio")
    ap.add_argument("--duration", type=float, help="live: tự dừng sau N giây (vd. 1800 cho test 30 phút)")
    ap.add_argument("--warmup-blocks", type=int, default=5)
    args = ap.parse_args()
    try:
        args.latency = float(args.latency)
    except ValueError:
        pass

    if args.list_devices:
        return list_devices()
    if args.roundtrip:
        return run_roundtrip(args)
    if not args.dummy and not args.model:
        ap.error("cần --model (hoặc --dummy)")
    if args.bench_input:
        return run_bench(args)
    return run_live(args)


if __name__ == "__main__":
    sys.exit(main())
