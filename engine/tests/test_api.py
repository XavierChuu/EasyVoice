"""API end-to-end trên CPU với TTS giả và RVC khởi tạo ngẫu nhiên (nghiệm thu: gọi được toàn bộ qua HTTP)."""

from __future__ import annotations

import io
import os
from pathlib import Path

import numpy as np
import soundfile as sf

from conftest import TOKEN, make_rvc_pth, voice_like, wait_job


def test_requires_token(client):
    from fastapi.testclient import TestClient

    anon = TestClient(client.app)
    r = anon.get("/system/health")
    assert r.status_code == 401 and r.json()["code"] == "UNAUTHORIZED"
    assert anon.get(f"/system/health?token={TOKEN}").status_code == 200
    assert anon.get("/openapi.json").status_code == 200  # Swagger mở được để test tay


def test_system_info(client):
    info = client.get("/system/info").json()
    assert info["device"] == "cpu" or info["device"].startswith(("cuda", "mps"))
    assert {m["id"] for m in info["models"]} >= {"f5tts-v1-base", "vocos-mel-24khz", "contentvec", "rmvpe"}
    assert all(not m["installed"] for m in info["models"])


def create_voice(client, wav_file, name="Giọng thử", language="en"):
    with wav_file.open("rb") as f:
        r = client.post("/voices", data={"name": name, "language": language, "transcript": "Some call me nature.",
                                         "consent": "true"}, files={"file": ("ref.wav", f, "audio/wav")})
    assert r.status_code == 200, r.text
    return r.json()


def test_voice_lifecycle(client, wav_file):
    with wav_file.open("rb") as f:
        a = client.post("/voices/analyze", files={"file": ("ref.wav", f, "audio/wav")}).json()
    assert 5.9 < a["durationSec"] < 6.1 and a["sampleRate"] == 44100 and a["warnings"] == []
    with wav_file.open("rb") as f:
        r = client.post("/voices", data={"name": "x", "transcript": "hi", "consent": "false"}, files={"file": f})
    assert r.status_code == 400
    v = create_voice(client, wav_file)
    assert v["capabilities"] == ["tts"] and v["hasRef"] and v["language"] == "en"
    assert [x["id"] for x in client.get("/voices").json()] == [v["id"]]
    prev = client.get(f"/voices/{v['id']}/preview")
    audio, sr = sf.read(io.BytesIO(prev.content))
    assert sr == 24000 and 4 < len(audio) / sr < 6.5  # đã resample 24 kHz + cắt khoảng lặng
    assert client.patch(f"/voices/{v['id']}", json={"name": "Đổi tên"}).json()["name"] == "Đổi tên"
    assert client.delete(f"/voices/{v['id']}").status_code == 204
    assert client.get(f"/voices/{v['id']}/preview").json()["code"] == "NOT_FOUND"


def test_tts_job_render_redo_export(client, state, wav_file):
    v = create_voice(client, wav_file)
    text = "Hello there. The ticket costs $5 and leaves at 7:30! Third sentence here."
    job_id = client.post("/tts", json={"profileId": v["id"], "text": text, "speed": 1.0, "seed": 1, "pauseMs": 200}).json()["jobId"]
    job = wait_job(client, job_id)
    assert job["status"] == "done", job
    assert [s["status"] for s in job["sentences"]] == ["done"] * 3
    fake = state.extras["fake_tts"]
    assert "five dollars" in fake.calls[1][0] and "seven thirty" in fake.calls[1][0]  # đã chuẩn hóa tiếng Anh
    full, sr = sf.read(io.BytesIO(client.get(f"/tts/{job_id}/audio").content))
    one, _ = sf.read(io.BytesIO(client.get(f"/tts/{job_id}/audio?index=0").content))
    assert sr == 24000 and len(full) > len(one)
    out = client.get(f"/files/{job['files']['output']}")
    assert out.status_code == 200 and out.headers["content-type"].startswith("audio")
    # render lại câu 2 với seed khác, các câu khác giữ nguyên
    n_calls = len(fake.calls)
    client.post(f"/tts/{job_id}/redo", json={"index": 1})
    job = wait_job(client, job_id)
    assert job["status"] == "done" and len(fake.calls) == n_calls + 1 and fake.calls[-1][1] != fake.calls[1][1]
    for fmt in ("wav", "flac", "srt", "mp3"):
        r = client.get(f"/tts/{job_id}/export?format={fmt}")
        assert r.status_code == 200, (fmt, r.text)
    assert "00:00:00,000 -->" in client.get(f"/tts/{job_id}/export?format=srt").text


def test_tts_rejected_while_realtime(client, state, wav_file):
    v = create_voice(client, wav_file)
    state.queue.acquire_realtime()
    r = client.post("/tts", json={"profileId": v["id"], "text": "Hi."})
    assert r.status_code == 409 and r.json()["code"] == "GPU_BUSY_REALTIME"
    state.queue.release_realtime()


def test_not_implemented_features(client):
    assert client.post("/train").json()["code"] == "NOT_IMPLEMENTED"
    assert client.post("/realtime/start").status_code == 501


def test_unsafe_pth_is_blocked(client, tmp_path):
    import torch

    class Evil:
        def __reduce__(self):
            return (os.system, ("echo pwned > " + str(tmp_path / "pwned"),))

    bad = tmp_path / "free_voice_pack.pth"
    torch.save({"weight": Evil()}, bad)
    with bad.open("rb") as f:
        r = client.post("/voices/import/inspect", files=[("files", ("free_voice_pack.pth", f))])
    body = r.json()
    assert r.status_code == 200 and body["blocked"] is True
    assert not (tmp_path / "pwned").exists()  # code trong pickle không được chạy
    assert client.get("/voices").json() == []


def test_import_rvc_and_convert_offline(client, dummy_rvc_assets, tmp_path):
    pth = make_rvc_pth(tmp_path / "anime_v2.pth")
    with pth.open("rb") as f:
        ins = client.post("/voices/import/inspect", files=[("files", ("anime_v2.pth", f))]).json()
    assert ins["blocked"] is False and ins["sampleRate"] == 40000 and ins["capabilities"] == ["sts"]
    v = client.post("/voices/import", json={"token": ins["token"], "name": "Anime"}).json()
    assert v["capabilities"] == ["sts"] and v["imported"] and v["license"] == "unknown"
    src = tmp_path / "talk.wav"
    sf.write(src, voice_like(22050, 3.0), 22050)
    with src.open("rb") as f:
        r = client.post("/sts/offline", data={"profileId": v["id"], "pitch": "2", "separate": "true"}, files={"file": ("talk.wav", f)})
    job = wait_job(client, r.json()["jobId"], timeout=300)
    assert job["status"] == "done", job
    out, sr = sf.read(io.BytesIO(client.get(f"/sts/{job['id']}/audio?which=b").content))
    assert sr == 22050 and abs(len(out) / sr - 3.0) < 0.05  # cùng sample rate + độ dài với input (spec 3.3)
    assert np.isfinite(out).all()
    assert client.get(f"/sts/{job['id']}/audio?which=a").status_code == 200
    assert any("Tách nhạc nền chưa có" in line for line in job["log"])


def test_variants_and_multi_voice_tts(client, state, wav_file):
    a = create_voice(client, wav_file)
    with wav_file.open("rb") as f:
        r = client.post(f"/voices/{a['id']}/variants", data={"name": "Vui vẻ", "emotion": "happy", "transcript": "Tuyệt quá!"},
                        files={"file": ("happy.wav", f, "audio/wav")})
    assert r.status_code == 200, r.text
    happy = r.json()["variants"][0]
    assert happy["name"] == "Vui vẻ" and happy["emotion"] == "happy"
    with wav_file.open("rb") as f:  # trùng tên → lỗi rõ ràng
        dup = client.post(f"/voices/{a['id']}/variants", data={"name": "vui vẻ", "transcript": "x"},
                          files={"file": ("x.wav", f, "audio/wav")})
    assert dup.status_code == 400
    assert client.get(f"/voices/{a['id']}/preview?variant={happy['id']}").status_code == 200
    b = create_voice(client, wav_file)

    parts = [{"text": "Hello there. ", "profileId": a["id"]},
             {"text": "I am so happy! ", "profileId": a["id"], "variantId": happy["id"]},
             {"text": "And I am B.", "profileId": b["id"]}]
    job_id = client.post("/tts", json={"profileId": a["id"], "text": "".join(p["text"] for p in parts),
                                       "parts": parts}).json()["jobId"]
    job = wait_job(client, job_id)
    assert job["status"] == "done", job
    s = job["sentences"]
    assert [x["profileId"] for x in s] == [None, a["id"], b["id"]] and s[1]["variantId"] == happy["id"]
    refs = [Path(c[2]).relative_to(state.paths.voices).parts for c in state.extras["fake_tts"].calls]
    assert refs[0] == (a["id"], "ref.wav") and refs[1][:3] == (a["id"], "variants", happy["id"]) and refs[2][0] == b["id"]

    # giọng/biến thể không tồn tại → từ chối ngay, không tạo job
    bad = client.post("/tts", json={"profileId": a["id"], "text": "x", "variantId": "nope"})
    assert bad.status_code == 404
    assert client.delete(f"/voices/{a['id']}/variants/{happy['id']}").json()["variants"] == []


def test_voice_tags(client, wav_file):
    with wav_file.open("rb") as f:
        v = client.post("/voices", data={"name": "Lan", "language": "vi", "transcript": "Xin chào.", "consent": "true",
                                         "gender": "female", "country": "vn", "region": "south"},
                        files={"file": ("ref.wav", f, "audio/wav")}).json()
    assert (v["gender"], v["country"], v["region"]) == ("female", "VN", "south")
    # chỉ đổi trường được gửi; null = xóa thẻ
    u = client.patch(f"/voices/{v['id']}", json={"region": None}).json()
    assert u["name"] == "Lan" and u["gender"] == "female" and u["country"] == "VN" and u["region"] is None
    assert client.patch(f"/voices/{v['id']}", json={"country": "Vietnam"}).status_code == 400
    assert client.patch(f"/voices/{v['id']}", json={"gender": "robot"}).status_code == 422
