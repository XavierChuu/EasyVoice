"""Chuẩn hóa văn bản tiếng Anh tối thiểu (tiếng Anh là ngôn ngữ số 2, dùng để test trước)."""

from __future__ import annotations

import re
from collections.abc import Iterable

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
ORD = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth", "nine": "ninth", "twelve": "twelfth"}


def read_number(n: int) -> str:
    if n < 0:
        return "minus " + read_number(-n)
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("-" + ONES[n % 10] if n % 10 else "")
    if n < 1000:
        return ONES[n // 100] + " hundred" + (" " + read_number(n % 100) if n % 100 else "")
    for size, word in ((10**12, "trillion"), (10**9, "billion"), (10**6, "million"), (1000, "thousand")):
        if n >= size:
            hi, lo = divmod(n, size)
            return f"{read_number(hi)} {word}" + (f" {read_number(lo)}" if lo else "")
    return str(n)


def read_year(n: int) -> str:
    if 2000 <= n <= 2009:
        return read_number(n)
    hi, lo = divmod(n, 100)
    return f"{read_number(hi)} " + ("hundred" if lo == 0 else (f"oh {ONES[lo]}" if lo < 10 else read_number(lo)))


def ordinal(n: int) -> str:
    words = read_number(n)
    last = re.split(r"[ -]", words)[-1]
    if last in ORD:
        new = ORD[last]
    elif last.endswith("y"):
        new = last[:-1] + "ieth"
    else:
        new = last + "th"
    return words[: len(words) - len(last)] + new


NUM = r"\d{1,3}(?:,\d{3})+(?!\d)|\d+(?:\.\d+)?"


def read_tok(tok: str) -> str:
    if "." in tok:
        a, b = tok.split(".", 1)
        return f"{read_number(int(a.replace(',', '')))} point {' '.join(ONES[int(c)] for c in b)}"
    return read_number(int(tok.replace(",", "")))


ABBR = [(r"\bMr\.", "Mister"), (r"\bMrs\.", "Missus"), (r"\bDr\.", "Doctor"), (r"\bSt\.", "Saint"),
        (r"\be\.g\.", "for example"), (r"\bi\.e\.", "that is"), (r"\betc\.", "et cetera"), (r"\bvs\.?", "versus"),
        (r"\bNYC\b", "New York City"), (r"\bUSA\b", "U S A"), (r"\bAI\b", "A I")]
UNITS = [("km/h", "kilometers per hour"), ("mph", "miles per hour"), ("km", "kilometers"), ("kg", "kilograms"),
         ("cm", "centimeters"), ("mm", "millimeters"), ("°C", "degrees Celsius"), ("°F", "degrees Fahrenheit"),
         ("GB", "gigabytes"), ("MB", "megabytes"), ("m", "meters"), ("g", "grams")]


def _apply_dict(text: str, entries: Iterable[tuple[str, str]]) -> str:
    for src, dst in sorted(entries, key=lambda e: -len(e[0])):
        if src:
            text = re.sub(rf"(?<!\w){re.escape(src)}(?!\w)", dst, text)
    return text


def normalize_en(text: str, user_dict: Iterable[tuple[str, str]] = ()) -> str:
    t = _apply_dict(text.replace(" ", " "), user_dict)
    for pat, rep in ABBR:
        t = re.sub(pat, rep, t)
    t = re.sub(r"\b(\d{1,2}):(\d{2})\s?(am|pm|AM|PM)?\b", lambda m: read_number(int(m.group(1))) + (
        "" if m.group(2) == "00" else (" oh " + ONES[int(m.group(2))] if m.group(2)[0] == "0" else " " + read_number(int(m.group(2)))))
        + (" " + " ".join(m.group(3).upper()) if m.group(3) else ""), t)
    t = re.sub(r"\$\s?(" + NUM + r")", lambda m: read_tok(m.group(1)) + (" dollar" if m.group(1) == "1" else " dollars"), t)
    t = re.sub(r"(" + NUM + r")\s?%", lambda m: read_tok(m.group(1)) + " percent", t)
    for u, w in UNITS:
        t = re.sub(rf"({NUM})\s?{re.escape(u)}(?![\w/])", lambda m, w=w: f"{read_tok(m.group(1))} {w}", t)
    t = re.sub(r"\b(\d+)(st|nd|rd|th)\b", lambda m: ordinal(int(m.group(1))), t)
    t = re.sub(r"(?<![\d,.])(1[1-9]\d{2}|20\d{2})(?![\d,.])", lambda m: read_year(int(m.group(1))), t)
    t = re.sub(r"(?<![\w\d])-(" + NUM + ")", lambda m: "minus " + read_tok(m.group(1)), t)
    t = t.replace("&", " and ").replace("@", " at ").replace("+", " plus ").replace("=", " equals ")
    t = re.sub(NUM, lambda m: read_tok(m.group(0)), t)
    return re.sub(r"\s+", " ", t).strip()
