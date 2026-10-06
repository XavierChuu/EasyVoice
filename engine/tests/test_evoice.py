"""Phase 5: chia sẻ giọng .evoice — xuất / kiểm tra / nhập, chặn file giả mạo hoặc không an toàn (spec 3.5)."""

from __future__ import annotations

import json
import shutil
import zipfile

from conftest import make_rvc_pth, wait_job


def make_full_voice(client, state, tmp_path, wav_file):
    """Giọng có cả TTS (ref + 1 biến thể) và STS (model RVC) như giọng train xong."""
    with wav_file.open("rb") as f:
        v = client.post("/voices", data={"name": "Giọng Minh", "language": "vi", "transcript": "xin chào các bạn",
                                         "consent": "true", "gender": "male", "country": "VN"},
                        files={"file": ("ref.wav", f)}).json()
    with wav_file.open("rb") as f:
        client.post(f"/voices/{v['id']}/variants", data={"name": "Vui", "emotion": "happy", "transcript": "vui quá"},
                    files={"file": ("v.wav", f)})
    pth = make_rvc_pth(tmp_path / "v.pth")
    with pth.open("rb") as f:
        ins = client.post("/voices/import/inspect", files=[("files", ("v.pth", f))]).json()
    rvc = client.post("/voices/import", json={"token": ins["token"], "name": "tmp"}).json()
    src, dst = state.voices.dir(rvc["id"]), state.voices.dir(v["id"])
    for name in ("model.safetensors", "rvc.json"):
        shutil.copy2(src / name, dst / name)
    shutil.copy2(wav_file, dst / "preview.wav")
    state.voices.finish_training(v["id"], 40000)
    p = state.voices.get(v["id"])
    p.rvc_index = None
    state.voices._write(p)
    client.delete(f"/voices/{rvc['id']}")
    return v["id"]


def export(client, vid, **kw):
    body = {"includeModel": True, "includeRef": False, "license": "personal", "author": "Xavier"} | kw
    return client.post(f"/voices/{vid}/export", json=body)


def inspect(client, path):
    with open(path, "rb") as f:
        return client.post("/voices/import/inspect", files=[("files", (path.name, f))]).json()


def test_round_trip_with_model_ref_and_variants(client, state, tmp_path, wav_file):
    vid = make_full_voice(client, state, tmp_path, wav_file)
    r = export(client, vid, includeRef=True, license="commercial", destDir=str(tmp_path))
    assert r.status_code == 200, r.text
    out = tmp_path / "giọng-minh.evoice"
    assert r.json()["path"] == str(out) and r.json()["sizeMb"] > 0
    with zipfile.ZipFile(out) as z:
        names = set(z.namelist())
        manifest = json.loads(z.read("manifest.json"))
    assert {"manifest.json", "model.safetensors", "rvc.json", "ref.wav", "ref.txt", "preview.wav"} <= names
    assert any(n.startswith("variants/") for n in names)
    assert manifest["format_version"] == 1 and manifest["license"] == "commercial" and manifest["author"] == "Xavier"
    assert set(manifest["capabilities"]) == {"tts", "sts"} and all(len(f["sha256"]) == 64 for f in manifest["files"])

    ins = inspect(client, out)
    assert ins["kind"] == "evoice" and not ins["blocked"], ins
    assert {c["key"] for c in ins["checks"]} == {"format", "checksums", "model", "appVersion"}
    assert ins["author"] == "Xavier" and ins["license"] == "commercial" and set(ins["capabilities"]) == {"tts", "sts"}
    p = client.post("/voices/import", json={"token": ins["token"], "name": "Minh (nhập)"}).json()
    assert set(p["capabilities"]) == {"tts", "sts"} and p["imported"] and p["license"] == "commercial"
    assert p["author"] == "Xavier" and p["gender"] == "male" and p["country"] == "VN" and len(p["variants"]) == 1
    # Giọng nhập dùng được ngay cho TTS (cả biến thể)
    job = client.post("/tts", json={"profileId": p["id"], "variantId": p["variants"][0]["id"], "text": "Xin chào."}).json()
    assert wait_job(client, job["jobId"])["status"] == "done"


def test_imported_voice_never_reexports_ref_and_keeps_license(client, state, tmp_path, wav_file):
    vid = make_full_voice(client, state, tmp_path, wav_file)
    out = export(client, vid, includeRef=True, license="personal", author="A", destDir=str(tmp_path)).json()["path"]
    from pathlib import Path

    p = client.post("/voices/import", json={"token": inspect(client, Path(out))["token"], "name": "B"}).json()
    r = export(client, p["id"], includeRef=True, license="commercial", author="Kẻ khác", destDir=str(tmp_path / "x"))
    out2 = Path(r.json()["path"])
    assert out2.parent == state.paths.outputs  # thư mục không tồn tại → lưu vào outputs/
    with zipfile.ZipFile(out2) as z:
        m = json.loads(z.read("manifest.json"))
        assert "ref.wav" not in z.namelist() and not any(n.startswith("variants/") for n in z.namelist())
    assert m["author"] == "A" and m["license"] == "personal" and m["capabilities"] == ["sts"]
    # Không được chia sẻ lại → chặn xuất
    pr = state.voices.get(p["id"])
    pr.license = "noredist"
    state.voices._write(pr)
    assert export(client, p["id"]).json()["code"] == "BAD_REQUEST"


def test_tampered_or_unsafe_evoice_is_blocked(client, state, tmp_path, wav_file):
    vid = make_full_voice(client, state, tmp_path, wav_file)
    from pathlib import Path

    good = Path(export(client, vid, destDir=str(tmp_path)).json()["path"])

    def rewrite(name, edit):
        out = tmp_path / name
        with zipfile.ZipFile(good) as src, zipfile.ZipFile(out, "w") as dst:
            for item in src.infolist():
                data = src.read(item.filename)
                data = edit(item.filename, data, dst)
                if data is not None:
                    dst.writestr(item.filename, data)
        return out

    tampered = rewrite("t.evoice", lambda n, d, z: d[:-10] + b"0" * 10 if n == "model.safetensors" else d)
    ins = inspect(client, tampered)
    assert ins["blocked"] and any(c["key"] == "checksums" and c["bad"] for c in ins["checks"])

    def add_pth(n, d, z):
        if n == "manifest.json":
            z.writestr("evil.pth", b"x")
        return d

    ins = inspect(client, rewrite("p.evoice", add_pth))
    assert ins["blocked"] and "evil.pth" in ins["checks"][-1]["value"]

    def future(n, d, z):
        if n != "manifest.json":
            return d
        m = json.loads(d)
        m["min_app_version"] = "99.0.0"
        return json.dumps(m).encode()

    ins = inspect(client, rewrite("f.evoice", future))
    assert ins["blocked"] and ins["checks"][-1]["key"] == "appVersion"
    (tmp_path / "junk.evoice").write_bytes(b"not a zip")
    assert inspect(client, tmp_path / "junk.evoice")["blocked"]
    assert client.post("/voices/import", json={"token": ins["token"], "name": "x"}).json()["code"] == "NOT_FOUND"


def test_import_by_local_path_and_clear_errors(client, state, tmp_path, wav_file):
    """App desktop gửi đường dẫn (file .evoice lớn không đọc vào renderer); file sai loại báo rõ tên file."""
    vid = make_full_voice(client, state, tmp_path, wav_file)
    out = export(client, vid, destDir=str(tmp_path)).json()["path"]
    ins = client.post("/voices/import/inspect", data={"paths": json.dumps([out])}).json()
    assert ins["kind"] == "evoice" and not ins["blocked"], ins
    assert ins["fileLabel"] == "giọng-minh.evoice"
    from pathlib import Path

    assert Path(out).exists()  # file của người dùng không bị xoá sau khi kiểm tra
    p = client.post("/voices/import", json={"token": ins["token"], "name": "Qua đường dẫn"}).json()
    assert p["imported"]
    r = client.post("/voices/import/inspect", data={"paths": json.dumps([str(wav_file)])}).json()
    assert r["code"] == "BAD_FILE" and wav_file.name in r["detail"]
    r = client.post("/voices/import/inspect", data={"paths": json.dumps([str(tmp_path / "missing.evoice")])}).json()
    assert r["code"] == "BAD_FILE" and "missing.evoice" in r["detail"]


def test_quick_voice_rejects_overlong_reference_with_clear_error(client, tmp_path):
    import numpy as np
    import soundfile as sf

    long = tmp_path / "ca-buoi-thu.wav"
    sf.write(long, np.zeros(16000 * 125, dtype=np.float32), 16000)
    with long.open("rb") as f:
        r = client.post("/voices", data={"name": "Dài", "language": "vi", "transcript": "xin chào", "consent": "true"},
                        files={"file": ("ca-buoi-thu.wav", f)})
    assert r.status_code == 413 and r.json()["code"] == "FILE_TOO_LARGE"
    assert r.json()["detail"].startswith("ca-buoi-thu.wav: audio dài 2.1 phút")
