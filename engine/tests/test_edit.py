"""Edit Audio: dự án + asset, xử lý tín hiệu (loudness, limiter, lọc, khoảng lặng, ducking), các thao tác AI chạy bằng
model giả (Whisper, Demucs, F5-TTS) hoặc khởi tạo ngẫu nhiên (RVC, WavLM), xuất file + phụ đề."""

from __future__ import annotations

import io
import math

import numpy as np
import pytest
import soundfile as sf

from conftest import make_rvc_pth, voice_like, wait_job
from easyvoice_engine.services.edit import dsp
from easyvoice_engine.services.edit.store import PROJECT_SR as SR, EditClip, EditTimeline, EditTrack
from easyvoice_engine.services.registry import ASR_KEY, SEP_KEY, SPK_KEY


class FakeWhisper:
    """Mỗi từ dài 0,4 s, cách nhau 0,1 s, phủ hết độ dài file."""

    def words(self, path, language):
        dur = sf.info(str(path)).duration
        out, t, i = [], 0.05, 0
        while t + 0.4 <= dur:
            out.append((t, t + 0.4, f" từ{i}"))
            t += 0.5
            i += 1
        return out

    def transcribe(self, path, language):
        return " ".join(w for _, _, w in self.words(path, language))


class FakeSeparator:
    def separate(self, audio, sr, on_progress=None):
        return audio * 0.8, audio * 0.2


def sine(freq: float, sec: float, amp: float = 1.0, sr: int = SR) -> np.ndarray:
    return (amp * np.sin(2 * np.pi * freq * np.arange(int(sr * sec)) / sr)).astype(np.float32)


def speaker(f0: float, bright: float, sec: float, sr: int = 16000) -> np.ndarray:
    """Giọng tổng hợp: cao độ f0 dao động nhẹ, phổ hài âm tối (bright nhỏ) hoặc sáng."""
    t = np.arange(int(sr * sec)) / sr
    ph = 2 * np.pi * np.cumsum(f0 * (1 + 0.04 * np.sin(2 * np.pi * 3 * t))) / sr
    x = sum(np.sin(k * ph) * bright ** (k - 1) for k in range(1, 12))
    env = 0.7 + 0.3 * np.sin(2 * np.pi * 2.2 * t)
    return (0.2 * x * env / np.max(np.abs(x))).astype(np.float32)


# ---------------------------------------------------------------- DSP
def test_loudness_matches_bs1770_reference():
    # BS.1770: sóng sin 997 Hz biên độ tối đa trên một kênh = -3,01 LUFS
    assert abs(dsp.loudness(sine(997, 5.0), SR) - (-3.01)) < 0.05
    assert abs(dsp.loudness(sine(997, 5.0, 0.1), SR) - (-23.01)) < 0.05
    assert dsp.loudness(np.zeros(SR * 2, np.float32), SR) == float("-inf")


def test_normalize_loudness_and_limiter():
    x = voice_like(SR, 6.0) * 0.1
    y = dsp.normalize_loudness(x, SR, -16.0)
    assert abs(dsp.loudness(y, SR) - (-16.0)) < 0.6
    assert dsp.peak_db(y) <= -1.0 + 1e-3
    loud = sine(220, 2.0, 3.0)  # vượt 0 dBFS
    assert dsp.peak_db(dsp.limit(loud, SR, -1.0)) <= -1.0 + 1e-3


def test_filters_keep_length_and_shape_spectrum():
    x = (sine(60, 2.0, 0.5) + sine(2000, 2.0, 0.2)).astype(np.float32)
    hp, _ = dsp.apply_filter("highpass", x, SR, 200)
    assert len(hp) == len(x)
    spec = np.abs(np.fft.rfft(hp[SR // 2:]))
    freqs = np.fft.rfftfreq(len(hp[SR // 2:]), 1 / SR)
    assert spec[np.argmin(np.abs(freqs - 60))] < 0.05 * spec[np.argmin(np.abs(freqs - 2000))]
    for name in ("eq_voice", "eq_warm", "eq_bright", "telephone", "compress", "normalize", "loudness", "denoise"):
        y, note = dsp.apply_filter(name, voice_like(SR, 1.5), SR)
        assert len(y) == int(SR * 1.5) and np.isfinite(y).all() and note


def test_silences_and_ducking():
    x = np.concatenate([voice_like(SR, 2.0), np.zeros(SR * 2, np.float32), voice_like(SR, 1.0)])
    ranges = dsp.find_silences(x, SR, -45, 0.8, keep_sec=0.25)
    long = [r for r in ranges if r[1] - r[0] > 1.0]
    assert len(long) == 1 and abs(long[0][0] - 2.25) < 0.1 and abs(long[0][1] - 3.75) < 0.1
    voice = np.concatenate([np.zeros(SR, np.float32), sine(200, 2.0, 0.3), np.zeros(SR * 2, np.float32)])
    env = dsp.duck_envelope(voice, SR, len(voice), -12)
    assert env[int(0.5 * SR)] > 0.95 and abs(env[int(2.0 * SR)] - 10 ** (-12 / 20)) < 0.05 and env[-1] > 0.9


def test_render_respects_gain_fades_mute_solo():
    assets = {"a": np.ones(SR * 2, np.float32) * 0.5, "b": np.ones(SR, np.float32) * 0.25}
    t = EditTimeline(name="x", tracks=[EditTrack(id="t1", name="1"), EditTrack(id="t2", name="2", gain_db=-6.0206)],
                     clips=[EditClip(id="c1", track_id="t1", asset_id="a", start=0.5, offset=0.5, duration=1.0, fade_in=0.5),
                            EditClip(id="c2", track_id="t2", asset_id="b", start=0.0, offset=0.0, duration=1.0)])
    y = dsp.render(t, assets.__getitem__, SR)
    assert len(y) == int(1.5 * SR)
    assert abs(y[int(0.25 * SR)] - 0.125) < 1e-3  # track 2 giảm 6 dB
    assert abs(y[int(1.25 * SR)] - 0.5) < 1e-3  # clip 1 sau fade-in
    assert abs(y[int(0.75 * SR)] - (0.25 + 0.125)) < 0.01  # giữa fade-in (0,5 × 0,5) + track 2
    t.tracks[0].solo = True
    assert abs(dsp.render(t, assets.__getitem__, SR)[int(0.25 * SR)]) < 1e-6
    t.tracks[0].solo, t.tracks[1].mute = False, True
    assert abs(dsp.render(t, assets.__getitem__, SR)[int(0.25 * SR)]) < 1e-6


# ---------------------------------------------------------------- nhận diện người nói
def test_diarize_two_synthetic_speakers_with_mel_stats():
    from easyvoice_engine.services.edit.diarize import MelStatsEmbedder, diarize

    gap = np.zeros(int(16000 * 0.5), np.float32)
    a, b = lambda s: speaker(110, 0.45, s), lambda s: speaker(240, 0.85, s)
    audio = np.concatenate([a(4), gap, b(4), gap, a(3), gap, b(3)])
    turns, n = diarize([("x", audio)], MelStatsEmbedder())
    assert n == 2
    labels = [lb for _, _, lb in turns["x"]]
    assert labels == [0, 1, 0, 1]
    assert abs(turns["x"][1][0] - 4.5) < 0.4
    single, n1 = diarize([("y", a(6))], MelStatsEmbedder())
    assert n1 == 1 and {lb for _, _, lb in single["y"]} == {0}


def test_wavlm_embedder_runs_with_random_weights():
    from easyvoice_engine.services.edit.diarize import WavLMEmbedder

    e = WavLMEmbedder(None, "cpu").embed([speaker(120, 0.5, 1.5), speaker(220, 0.8, 1.0)])
    assert e.shape[0] == 2 and np.allclose(np.linalg.norm(e, axis=1), 1, atol=1e-4)


# ---------------------------------------------------------------- API
@pytest.fixture
def edit_client(client, state):
    state.models.register(ASR_KEY, lambda device: FakeWhisper(), "asr")
    state.models.register(SEP_KEY, lambda device: FakeSeparator(), "sep")
    return client


def new_project_with_audio(client, tmp_path, seconds=4.0, sr=22050):
    p = client.post("/edit/projects", json={"name": "Podcast"}).json()
    src = tmp_path / "talk.wav"
    sf.write(src, voice_like(sr, seconds), sr)
    with src.open("rb") as f:
        assets = client.post(f"/edit/projects/{p['id']}/assets", files=[("files", ("talk.wav", f))]).json()
    a = assets[0]
    timeline = {"name": "Podcast", "tracks": [{"id": "t1", "name": "Audio 1"}],
                "clips": [{"id": "c1", "trackId": "t1", "assetId": a["id"], "start": 0, "offset": 0, "duration": a["durationSec"]}]}
    saved = client.put(f"/edit/projects/{p['id']}", json=timeline).json()
    return p["id"], a, saved


def run(client, pid, body, timeout=120):
    r = client.post(f"/edit/projects/{pid}/ops", json=body)
    assert r.status_code == 200, r.text
    job = wait_job(client, r.json()["jobId"], timeout=timeout)
    assert job["status"] == "done", job["log"][-5:]
    return job


def test_project_crud_assets_and_validation(edit_client, tmp_path):
    c = edit_client
    pid, a, saved = new_project_with_audio(c, tmp_path)
    assert a["sampleRate"] == SR and abs(a["durationSec"] - 4.0) < 0.01 and a["words"] is None
    assert saved["clips"][0]["assetId"] == a["id"] and saved["ripple"] == "all"
    audio, sr = sf.read(io.BytesIO(c.get(f"/edit/projects/{pid}/assets/{a['id']}/audio").content))
    assert sr == SR and abs(len(audio) / sr - 4.0) < 0.01
    lst = c.get("/edit/projects").json()
    assert lst[0]["id"] == pid and lst[0]["tracks"] == 1 and abs(lst[0]["durationSec"] - 4.0) < 0.01
    bad = {"name": "x", "tracks": [{"id": "t1", "name": "1"}],
           "clips": [{"id": "c", "trackId": "t1", "assetId": "nope", "start": 0, "offset": 0, "duration": 1}]}
    assert c.put(f"/edit/projects/{pid}", json=bad).json()["code"] == "BAD_REQUEST"
    assert c.get("/edit/projects/zzz").status_code == 404
    # Asset không clip nào dùng bị dọn khi mở lại dự án (gc)
    run(c, pid, {"op": "filter", "segments": [{"assetId": a["id"], "offset": 0, "duration": 1}], "filter": "eq_voice"})
    assert len(c.get(f"/edit/projects/{pid}/assets").json()) == 2
    assert len(c.get(f"/edit/projects/{pid}?gc=true").json()["assets"]) == 1
    assert c.delete(f"/edit/projects/{pid}").status_code == 204
    assert c.get(f"/edit/projects/{pid}").status_code == 404


def test_filter_transcribe_separate_and_diarize(edit_client, state, tmp_path):
    c = edit_client
    pid, a, _ = new_project_with_audio(c, tmp_path)
    job = run(c, pid, {"op": "filter", "segments": [{"assetId": a["id"], "offset": 1.0, "duration": 1.5}], "filter": "denoise", "amount": 0.7})
    assert job["kind"] == "mix"
    new = next(x for x in c.get(f"/edit/projects/{pid}/assets").json() if x["id"] == job["result"]["assets"][0])
    assert abs(new["durationSec"] - 1.5) < 1e-3 and new["source"] == "filter"

    job = run(c, pid, {"op": "transcribe", "assetIds": [a["id"]], "language": "vi"})
    assert job["kind"] == "edit" and job["result"]["words"] == 8
    words = c.get(f"/edit/projects/{pid}/assets").json()[0]["words"]
    assert words[0] == {"start": 0.05, "end": 0.45, "text": "từ0"}

    state.catalog.path("demucs-htdemucs").parent.mkdir(parents=True, exist_ok=True)
    state.catalog.path("demucs-htdemucs").write_bytes(b"x")
    job = run(c, pid, {"op": "separate", "assetIds": [a["id"]]})
    vid, mid = job["result"]["pairs"][a["id"]]
    assets = {x["id"]: x for x in c.get(f"/edit/projects/{pid}/assets").json()}
    assert assets[vid]["words"] == words and assets[mid]["words"] is None  # lời thoại theo track giọng

    job = run(c, pid, {"op": "diarize", "assetIds": [a["id"]]})
    assert job["result"]["embedder"] == "log-mel" and job["result"]["base"] == 0
    turns = c.get(f"/edit/projects/{pid}/assets").json()[0]["turns"]
    assert turns and all(t["speaker"] >= 0 for t in turns)
    # Nhận diện tiếp asset khác: người nói đánh số tiếp, không trùng
    job = run(c, pid, {"op": "diarize", "assetIds": [vid]})
    assert job["result"]["base"] == max(t["speaker"] for t in turns) + 1


def test_separate_requires_demucs(edit_client, tmp_path):
    pid, a, _ = new_project_with_audio(edit_client, tmp_path)
    r = edit_client.post(f"/edit/projects/{pid}/ops", json={"op": "separate", "assetIds": [a["id"]]})
    assert r.status_code == 424 and r.json()["code"] == "MODEL_MISSING"


def test_retext_speak_and_render_with_srt(edit_client, state, tmp_path, wav_file):
    c = edit_client
    pid, a, saved = new_project_with_audio(c, tmp_path)
    run(c, pid, {"op": "transcribe", "assetIds": [a["id"]]})
    # Sửa từ thứ 3 (1,05–1,45 s): giữ nguyên độ dài
    job = run(c, pid, {"op": "retext", "assetId": a["id"], "offset": 1.05, "duration": 0.4, "text": "xin chào", "keepDuration": True})
    res = job["result"]
    assert abs(res["replaceOffset"] - 1.01) < 1e-3 and abs(res["replaceDuration"] - 0.48) < 1e-3
    fake = state.extras["fake_tts"]
    text, _, kind = fake.calls[-1]
    # Lời mới kèm lời ngữ cảnh hai bên (đã chuẩn hóa: số đọc thành chữ), bỏ đúng từ bị thay ("từ2")
    assert kind == "edit" and text.startswith("từkhông từmột xin chào từba") and "từhai" not in text
    assets = {x["id"]: x for x in c.get(f"/edit/projects/{pid}/assets").json()}
    new = assets[res["assets"][0]]
    assert abs(new["durationSec"] - 0.48) < 2e-3 and [w["text"] for w in new["words"]] == ["xin", "chào"]
    # Không giữ độ dài: độ dài theo nhịp nói của phần xung quanh
    job = run(c, pid, {"op": "retext", "assetId": a["id"], "offset": 1.05, "duration": 0.4,
                       "text": "một câu dài hơn hẳn đoạn cũ nhiều lắm"})
    longer = next(x for x in c.get(f"/edit/projects/{pid}/assets").json() if x["id"] == job["result"]["assets"][0])
    assert abs(job["result"]["replaceDuration"] - 0.48) < 1e-3 and longer["durationSec"] > 1.0

    # Đọc bằng giọng đã lưu
    with wav_file.open("rb") as f:
        v = c.post("/voices", data={"name": "Giọng A", "language": "vi", "transcript": "xin chào", "consent": "true"},
                   files={"file": ("ref.wav", f)}).json()
    job = run(c, pid, {"op": "speak", "profileId": v["id"], "text": "Chào bạn"})
    sp = next(x for x in c.get(f"/edit/projects/{pid}/assets").json() if x["id"] == job["result"]["assets"][0])
    assert sp["source"] == "speak" and sp["durationSec"] > 0.2

    # Xuất: thêm track 2 dùng asset đọc, có tên người nói → phụ đề
    tl = saved | {"tracks": saved["tracks"] + [{"id": "t2", "name": "Chen"}],
                  "clips": saved["clips"] + [{"id": "c2", "trackId": "t2", "assetId": sp["id"], "start": 5.0, "offset": 0,
                                               "duration": sp["durationSec"], "speaker": 1}],
                  "speakers": [{"id": 1, "name": "Khách", "color": "#ff0000"}]}
    tl = {k: tl[k] for k in ("name", "tracks", "clips", "speakers", "ripple")}
    job = run(c, pid, {"op": "render", "timeline": tl, "format": "wav", "targetLufs": -16, "srt": True})
    res = job["result"]
    assert abs(res["lufs"] - (-16)) < 0.8 and res["peakDb"] <= -0.99
    audio, sr = sf.read(io.BytesIO(c.get(f"/files/{res['file']}").content))
    assert sr == SR and abs(len(audio) / sr - (5.0 + sp["durationSec"])) < 0.01
    srt = c.get(f"/files/{res['srt']}").content.decode("utf-8")
    assert "00:00:00,050 -->" in srt and "từ0" in srt and "Khách: Chào bạn" in srt
    # Chỉ đo, không xuất file
    m = run(c, pid, {"op": "render", "timeline": tl})["result"]
    assert "file" not in m and math.isfinite(m["lufs"])


def test_silences_duck_and_open_tts_result(edit_client, state, tmp_path, wav_file):
    c = edit_client
    p = c.post("/edit/projects", json={"name": "Mix"}).json()
    pid = p["id"]
    x = np.concatenate([voice_like(SR, 1.5), np.zeros(SR * 2, np.float32), voice_like(SR, 1.5)])
    src = tmp_path / "gap.wav"
    sf.write(src, x, SR)
    music = tmp_path / "music.wav"
    sf.write(music, sine(330, 5.0, 0.3), SR)
    with src.open("rb") as f1, music.open("rb") as f2:
        a, m = c.post(f"/edit/projects/{pid}/assets", files=[("files", ("gap.wav", f1)), ("files", ("music.wav", f2))]).json()
    tl = {"name": "Mix", "tracks": [{"id": "v", "name": "Giọng"}, {"id": "m", "name": "Nhạc", "kind": "music"}],
          "clips": [{"id": "c1", "trackId": "v", "assetId": a["id"], "start": 0, "offset": 0, "duration": a["durationSec"]},
                    {"id": "c2", "trackId": "m", "assetId": m["id"], "start": 0, "offset": 0, "duration": m["durationSec"]}]}
    r = run(c, pid, {"op": "silences", "timeline": tl, "trackIds": ["v"]})["result"]["ranges"]
    assert len(r) == 1 and abs(r[0][0] - 1.75) < 0.1 and abs(r[0][1] - 3.25) < 0.1
    job = run(c, pid, {"op": "duck", "timeline": tl, "musicTrackIds": ["m"], "voiceTrackIds": ["v"], "amountDb": -12})
    ducked = c.get(f"/edit/projects/{pid}/assets/{job['result']['tracks']['m']}/audio").content
    y, _ = sf.read(io.BytesIO(ducked))
    assert np.abs(y[int(0.7 * SR): int(1.2 * SR)]).max() < 0.15 and np.abs(y[int(2.6 * SR): int(2.9 * SR)]).max() > 0.25

    # Mở kết quả TTS trong Edit Audio: có lời thoại theo câu
    with wav_file.open("rb") as f:
        v = c.post("/voices", data={"name": "A", "language": "vi", "transcript": "xin chào", "consent": "true"},
                   files={"file": ("ref.wav", f)}).json()
    tid = c.post("/tts", json={"profileId": v["id"], "text": "Xin chào. Hẹn gặp lại!"}).json()["jobId"]
    assert wait_job(c, tid)["status"] == "done"
    proj = c.post("/edit/projects/from-job", json={"jobId": tid}).json()
    assert len(proj["tracks"]) == 1 and len(proj["clips"]) == 1
    words = proj["assets"][0]["words"]
    assert [w["text"] for w in words] == ["Xin", "chào.", "Hẹn", "gặp", "lại!"]
    assert words[2]["start"] > words[1]["end"]  # có khoảng nghỉ giữa hai câu


def test_convert_segment_with_rvc(edit_client, dummy_rvc_assets, tmp_path):
    c = edit_client
    pth = make_rvc_pth(tmp_path / "v.pth")
    with pth.open("rb") as f:
        ins = c.post("/voices/import/inspect", files=[("files", ("v.pth", f))]).json()
    v = c.post("/voices/import", json={"token": ins["token"], "name": "RVC"}).json()
    pid, a, _ = new_project_with_audio(c, tmp_path, seconds=3.0)
    job = run(c, pid, {"op": "convert", "segments": [{"assetId": a["id"], "offset": 0.5, "duration": 1.2}], "profileId": v["id"]},
              timeout=300)
    new = next(x for x in c.get(f"/edit/projects/{pid}/assets").json() if x["id"] == job["result"]["assets"][0])
    assert abs(new["durationSec"] - 1.2) < 1e-3 and new["source"] == "convert"
    r = c.post(f"/edit/projects/{pid}/ops", json={"op": "convert", "segments": [{"assetId": a["id"], "offset": 0, "duration": 1}],
                                                  "profileId": "missing"})
    assert r.status_code == 404


def test_speaker_model_used_when_installed(state):
    from easyvoice_engine.services.registry import SPEAKER_ID

    assert state.models.get(SPK_KEY).name == "log-mel"
    assert SPEAKER_ID in state.catalog.models and not state.catalog.installed(SPEAKER_ID)
