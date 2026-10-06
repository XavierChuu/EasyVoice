"""Màn hình Cài đặt (spec Phase 5): thiết bị áp dụng ngay, đổi thư mục model / giọng có hiệu lực sau khi khởi động lại."""

from __future__ import annotations

from conftest import TOKEN
from easyvoice_engine.core.state import EngineState


def test_settings_device_and_folders(client, state, tmp_path):
    s = client.get("/system/settings").json()
    assert s["device"] == "auto" and s["modelsDir"] == "" and not s["restartRequired"]
    s = client.put("/system/settings", json={"device": "cpu"}).json()
    assert s["device"] == "cpu" and state.device() == "cpu"
    new_models = tmp_path / "D" / "models"
    s = client.put("/system/settings", json={"modelsDir": str(new_models)}).json()
    assert s["restartRequired"] and s["modelsDir"] == str(new_models) and new_models.is_dir()
    assert client.put("/system/settings", json={"voicesDir": "relative/path"}).json()["code"] == "BAD_REQUEST"
    # "Khởi động lại": engine mới đọc settings.json → dùng thư mục mới
    st2 = EngineState.create(TOKEN, state.paths.root)
    assert st2.paths.models == new_models and st2.settings.device == "cpu"
    st2.queue.shutdown()
    s = client.put("/system/settings", json={"modelsDir": ""}).json()
    assert s["modelsDir"] == "" and not s["restartRequired"]
