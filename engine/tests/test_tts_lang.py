from types import SimpleNamespace

from easyvoice_engine.services.models import ManifestModel
from easyvoice_engine.services.registry import TTS_KEY, pick_tts_model, tts_key
from easyvoice_engine.services.tts.pipeline import text_language


def _state(installed: set[str], default="base"):
    models = {
        "base": ManifestModel(id="base", name="Base", role="Text to Speech", group="tts", license="x",
                              languages=["en", "zh"], files=[]),
        "vi": ManifestModel(id="vi", name="VI", role="Text to Speech", group="tts", license="x",
                            languages=["vi"], lowercase=True, files=[]),
    }
    cat = SimpleNamespace(models=models, installed=lambda mid: mid in installed)
    return SimpleNamespace(catalog=cat, settings=SimpleNamespace(tts_model=default))


def test_text_language():
    assert text_language("Xin chào các bạn", "en") == "vi"
    assert text_language("Hello there", "vi") == "vi"  # không có dấu → theo ngôn ngữ giọng mẫu
    assert text_language("Hello there", "en") == "en"
    assert text_language("Hello", "unknown") == "en"


def test_pick_vi_model_when_installed():
    st = _state({"base", "vi"})
    assert pick_tts_model(st, "vi") == "vi"
    assert pick_tts_model(st, "en") == "base"
    assert tts_key(st, "base") == TTS_KEY and tts_key(st, "vi") == "tts:vi"


def test_fallback_to_default_when_vi_missing():
    assert pick_tts_model(_state({"base"}), "vi") == "base"
