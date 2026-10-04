"""Tách văn bản dài thành câu để render từng đoạn (spec 3.2). Câu quá dài được cắt tiếp ở dấu phẩy/chấm phẩy."""

from __future__ import annotations

import re

MAX_CHARS = 220  # F5-TTS ổn định nhất với đoạn ngắn; engine render từng câu


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?…])\s+|\n+", text.strip())
    return [p.strip() for p in parts if p and p.strip()]


def split_long(sentence: str, max_chars: int = MAX_CHARS) -> list[str]:
    if len(sentence) <= max_chars:
        return [sentence]
    out: list[str] = []
    cur = ""
    for piece in re.split(r"(?<=[,;:])\s+", sentence):
        if cur and len(cur) + 1 + len(piece) > max_chars:
            out.append(cur)
            cur = piece
        else:
            cur = f"{cur} {piece}".strip()
    if cur:
        out.append(cur)
    final: list[str] = []
    for chunk in out:  # vẫn quá dài (không có dấu phẩy): cắt theo từ
        while len(chunk) > max_chars:
            cut = chunk.rfind(" ", 0, max_chars)
            cut = cut if cut > 0 else max_chars
            final.append(chunk[:cut].strip())
            chunk = chunk[cut:].strip()
        if chunk:
            final.append(chunk)
    return final
