"""Chọn bộ chuẩn hóa theo ngôn ngữ của profile."""

from __future__ import annotations

from collections.abc import Iterable

from .text_normalize_en import normalize_en
from .text_normalize_vi import normalize_vi


def normalize(text: str, lang: str, user_dict: Iterable[tuple[str, str]] = ()) -> str:
    return normalize_en(text, user_dict) if lang == "en" else normalize_vi(text, user_dict)
