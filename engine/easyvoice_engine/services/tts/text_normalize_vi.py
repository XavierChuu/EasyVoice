"""Chuẩn hóa văn bản tiếng Việt trước khi đưa vào TTS (spec 3.2): số, ngày giờ, tiền tệ, đơn vị, %,
viết tắt phổ biến, ký hiệu, cộng từ điển phát âm riêng của người dùng.

Quy ước đọc số: "linh" cho hàng chục bằng 0 (một trăm linh năm), "mốt" (hai mươi mốt), "tư" (hai mươi tư),
"lăm" (mười lăm). Dấu "." là phân cách nghìn khi theo sau là nhóm 3 chữ số; dấu "," là dấu thập phân.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]
UNITS = ["", "nghìn", "triệu", "tỷ"]


def _below_thousand(n: int, full: bool) -> str:
    """n < 1000. full=True: luôn đọc hàng trăm (nhóm không đứng đầu: 'không trăm linh năm')."""
    h, t, u = n // 100, n // 10 % 10, n % 10
    out: list[str] = []
    if h or full:
        out += [DIGITS[h], "trăm"]
    if t == 0:
        if u and (h or full):
            out.append("linh")
    elif t == 1:
        out.append("mười")
    else:
        out += [DIGITS[t], "mươi"]
    if u:
        if u == 1 and t >= 2:
            out.append("mốt")
        elif u == 5 and t >= 1:
            out.append("lăm")
        elif u == 4 and t >= 2:
            out.append("tư")
        else:
            out.append(DIGITS[u])
    return " ".join(out)


def read_number(n: int) -> str:
    """Đọc số nguyên. Hỗ trợ tới hàng nghìn tỷ trở lên (lặp 'tỷ')."""
    if n < 0:
        return "âm " + read_number(-n)
    if n == 0:
        return "không"
    if n >= 10**9:
        high, low = divmod(n, 10**9)
        rest = read_number_groups(low, leading=False) if low else ""
        return f"{read_number(high)} tỷ" + (f" {rest}" if rest else "")
    return read_number_groups(n, leading=True)


def read_number_groups(n: int, leading: bool) -> str:
    groups: list[int] = []
    while n:
        groups.append(n % 1000)
        n //= 1000
    parts: list[str] = []
    for i in range(len(groups) - 1, -1, -1):
        g = groups[i]
        if not g:
            continue
        is_first = i == len(groups) - 1 and leading
        parts.append(_below_thousand(g, full=not is_first))
        if UNITS[i]:
            parts.append(UNITS[i])
    return " ".join(parts)


def read_digits(s: str) -> str:
    return " ".join(DIGITS[int(c)] for c in s if c.isdigit())


def read_decimal(int_part: str, frac: str) -> str:
    frac_read = read_digits(frac) if frac.startswith("0") else read_number(int(frac))
    return f"{read_number(int(int_part))} phẩy {frac_read}"


def _int(s: str) -> int:
    return int(s.replace(".", ""))


# Số: 1.234.567 | 3,5 | 42
NUM = r"\d{1,3}(?:\.\d{3})+(?!\d)|\d+(?:,\d+)?"
# Số có thể kèm dấu âm (dấu "-" không dính vào chữ/số đứng trước)
SNUM = rf"(?:(?<![\w\d])-)?(?:{NUM})"


def read_num_token(tok: str) -> str:
    if tok.startswith("-"):
        return "âm " + read_num_token(tok[1:])
    if "," in tok:
        a, b = tok.split(",", 1)
        return read_decimal(a.replace(".", ""), b)
    return read_number(_int(tok))


MONTHS = {4: "tư"}


def read_month(m: int) -> str:
    return MONTHS.get(m, read_number(m))


UNIT_WORDS: list[tuple[str, str]] = [
    ("km/h", "ki lô mét trên giờ"), ("m/s", "mét trên giây"), ("km²", "ki lô mét vuông"), ("km2", "ki lô mét vuông"),
    ("m²", "mét vuông"), ("m2", "mét vuông"), ("m³", "mét khối"), ("m3", "mét khối"), ("°C", "độ C"), ("°F", "độ F"),
    ("km", "ki lô mét"), ("cm", "xăng ti mét"), ("mm", "mi li mét"), ("kg", "ki lô gam"), ("mg", "mi li gam"),
    ("ml", "mi li lít"), ("kWh", "ki lô oát giờ"), ("kW", "ki lô oát"), ("GB", "gi ga bai"), ("MB", "mê ga bai"),
    ("Hz", "héc"), ("m", "mét"), ("g", "gam"), ("l", "lít"), ("ha", "héc ta"),
]

CURRENCY: list[tuple[str, str]] = [
    ("VNĐ", "đồng"), ("VND", "đồng"), ("đồng", "đồng"), ("đ", "đồng"), ("USD", "đô la"), ("$", "đô la"),
    ("EUR", "ơ rô"), ("€", "ơ rô"),
]

ABBREVIATIONS: list[tuple[str, str]] = [
    (r"\bTP\.?\s?HCM\b", "thành phố Hồ Chí Minh"), (r"\bTp\.?\s?HCM\b", "thành phố Hồ Chí Minh"),
    (r"\bTP\.?\s?Hồ Chí Minh\b", "thành phố Hồ Chí Minh"), (r"\bTP\.(?=\s?\w)", "thành phố"), (r"\bTP\b", "thành phố"),
    (r"\bHN\b", "Hà Nội"), (r"\bUBND\b", "ủy ban nhân dân"), (r"\bHĐND\b", "hội đồng nhân dân"),
    (r"\bTHPT\b", "trung học phổ thông"), (r"\bTHCS\b", "trung học cơ sở"), (r"\bĐH\b", "đại học"),
    (r"\bPGS\.?\s?TS\b\.?", "phó giáo sư tiến sĩ"), (r"\bGS\.?\s?TS\b\.?", "giáo sư tiến sĩ"), (r"\bThS\b\.?", "thạc sĩ"),
    (r"\bTS\.(?=\s)", "tiến sĩ"), (r"\bBS\.(?=\s)", "bác sĩ"), (r"\bv\.v\.?", "vân vân"), (r"\bv/v\b", "về việc"),
    (r"\bCLB\b", "câu lạc bộ"), (r"\bCSGT\b", "cảnh sát giao thông"), (r"\bBHXH\b", "bảo hiểm xã hội"),
    (r"\bk/g\b", "kính gửi"), (r"\bSĐT\b", "số điện thoại"), (r"\bAI\b", "ây ai"),
]

ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def roman_to_int(s: str) -> int:
    total = 0
    for a, b in zip(s, s[1:] + " "):
        v = ROMAN[a]
        total += -v if b != " " and ROMAN.get(b, 0) > v else v
    return total


def _apply_dict(text: str, entries: Iterable[tuple[str, str]]) -> str:
    for src, dst in sorted(entries, key=lambda e: -len(e[0])):
        if src:
            text = re.sub(rf"(?<!\w){re.escape(src)}(?!\w)", dst, text)
    return text


def normalize_vi(text: str, user_dict: Iterable[tuple[str, str]] = ()) -> str:
    t = text.replace(" ", " ")
    t = _apply_dict(t, user_dict)

    for pat, rep in ABBREVIATIONS:
        t = re.sub(pat, rep, t)

    # Thế kỷ / chương + số La Mã
    t = re.sub(r"\b(thế kỷ|Thế kỷ|chương|Chương|phần|Phần)\s+([IVXLCDM]+)\b",
               lambda m: f"{m.group(1)} {read_number(roman_to_int(m.group(2)))}", t)

    # Ngày tháng năm: 15/8/2026, 15-08-2026
    def date_full(m: re.Match) -> str:
        d, mo, y = int(m.group(2)), int(m.group(3)), int(m.group(4))
        if not (1 <= d <= 31 and 1 <= mo <= 12):
            return m.group(0)
        prefix = "" if m.group(1) else "ngày "
        return f"{m.group(1) or ''}{prefix}{read_number(d)} tháng {read_month(mo)} năm {read_number(y)}"

    t = re.sub(r"([Nn]gày\s+)?\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b", date_full, t)

    # Tháng/năm: 8/2026 (sau "tháng" hoặc đứng riêng)
    def month_year(m: re.Match) -> str:
        mo, y = int(m.group(2)), int(m.group(3))
        if not 1 <= mo <= 12:
            return m.group(0)
        return f"{m.group(1) or 'tháng '}{read_month(mo)} năm {read_number(y)}"

    t = re.sub(r"([Tt]háng\s+)?\b(\d{1,2})/(\d{4})\b", month_year, t)

    # Ngày/tháng: 15/8
    def day_month(m: re.Match) -> str:
        d, mo = int(m.group(2)), int(m.group(3))
        if not (1 <= d <= 31 and 1 <= mo <= 12):
            return m.group(0)
        return f"{m.group(1) or 'ngày '}{read_number(d)} tháng {read_month(mo)}"

    t = re.sub(r"([Nn]gày\s+)?\b(\d{1,2})/(\d{1,2})\b(?![/\d])", day_month, t)

    # Giờ: 7:30, 07h30, 7h, 19g15
    def time_hm(m: re.Match) -> str:
        h, mi = int(m.group(1)), int(m.group(2) or 0)
        if h > 24 or mi > 59:
            return m.group(0)
        return f"{read_number(h)} giờ" + (f" {read_number(mi)} phút" if mi else "")

    t = re.sub(r"\b(\d{1,2}):(\d{2})\b", time_hm, t)
    t = re.sub(r"\b(\d{1,2})h(\d{2})?\b", time_hm, t)
    t = re.sub(r"\b(\d{1,2})g(\d{2})\b", time_hm, t)  # 19g15 (không nhầm với 5g = 5 gam)

    # Số điện thoại / chuỗi số dài bắt đầu bằng 0: đọc từng chữ số
    t = re.sub(r"(?<![\d.,])(0\d{8,10})(?![\d.,])", lambda m: read_digits(m.group(1)), t)

    # Khoảng: 5-10, 5–10 → năm đến mười
    t = re.sub(rf"(?<![\w.,])({NUM})\s?[-–]\s?({NUM})(?![\w,]|\.\d)",
               lambda m: f"{read_num_token(m.group(1))} đến {read_num_token(m.group(2))}", t)

    # Phần trăm
    t = re.sub(rf"({SNUM})\s?%", lambda m: f"{read_num_token(m.group(1))} phần trăm", t)

    # Tiền tệ: ký hiệu đứng trước ($5) hoặc sau (100.000đ, 5 USD)
    for sym, word in CURRENCY:
        s = re.escape(sym)
        t = re.sub(rf"(?<!\w){s}\s?({NUM})", lambda m, w=word: f"{read_num_token(m.group(1))} {w}", t)
        t = re.sub(rf"({SNUM})\s?{s}(?![\w²³])", lambda m, w=word: f"{read_num_token(m.group(1))} {w}", t)

    # Đơn vị đo sau số
    for unit, word in UNIT_WORDS:
        t = re.sub(rf"({SNUM})\s?{re.escape(unit)}(?![\w²³/])", lambda m, w=word: f"{read_num_token(m.group(1))} {w}", t)

    # Thứ tự: thứ 1 → thứ nhất, thứ 4 → thứ tư
    t = re.sub(r"\b(thứ|Thứ)\s+1\b", r"\1 nhất", t)
    t = re.sub(r"\b(thứ|Thứ)\s+4\b", r"\1 tư", t)


    # Ký hiệu
    t = re.sub(rf"({NUM})\s?\+\s?({NUM})", lambda m: f"{read_num_token(m.group(1))} cộng {read_num_token(m.group(2))}", t)
    t = re.sub(rf"({NUM})\s?[x×]\s?({NUM})", lambda m: f"{read_num_token(m.group(1))} nhân {read_num_token(m.group(2))}", t)
    t = t.replace("&", " và ").replace("@", " a còng ").replace("=", " bằng ")

    # Số còn lại (kể cả số âm)
    t = re.sub(SNUM, lambda m: read_num_token(m.group(0)), t)

    return re.sub(r"\s+", " ", t).strip()
