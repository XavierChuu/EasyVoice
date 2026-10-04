"""≥ 50 case chuẩn hóa tiếng Việt (nghiệm thu Phase 1)."""

import pytest

from easyvoice_engine.services.tts.text_normalize_vi import normalize_vi, read_number

NUMBERS = [
    (0, "không"), (1, "một"), (4, "bốn"), (5, "năm"), (10, "mười"), (11, "mười một"), (14, "mười bốn"),
    (15, "mười lăm"), (20, "hai mươi"), (21, "hai mươi mốt"), (24, "hai mươi tư"), (25, "hai mươi lăm"),
    (55, "năm mươi lăm"), (99, "chín mươi chín"), (100, "một trăm"), (101, "một trăm linh một"),
    (105, "một trăm linh năm"), (110, "một trăm mười"), (115, "một trăm mười lăm"), (121, "một trăm hai mươi mốt"),
    (1000, "một nghìn"), (1005, "một nghìn không trăm linh năm"), (1050, "một nghìn không trăm năm mươi"),
    (2026, "hai nghìn không trăm hai mươi sáu"), (10000, "mười nghìn"), (15500, "mười lăm nghìn năm trăm"),
    (100000, "một trăm nghìn"), (1000000, "một triệu"), (1200000, "một triệu hai trăm nghìn"),
    (1000000000, "một tỷ"), (1005000000, "một tỷ không trăm linh năm triệu"),
    (3000000000000, "ba nghìn tỷ"), (-7, "âm bảy"),
]


@pytest.mark.parametrize(("n", "expected"), NUMBERS)
def test_read_number(n, expected):
    assert read_number(n) == expected


CASES = [
    ("Tôi có 3 quả táo.", "Tôi có ba quả táo."),
    ("Dân số 1.234.567 người", "Dân số một triệu hai trăm ba mươi tư nghìn năm trăm sáu mươi bảy người"),
    ("Giá trị 3,5", "Giá trị ba phẩy năm"),
    ("Pi bằng 3,14", "Pi bằng ba phẩy mười bốn"),
    ("Lãi suất 0,05", "Lãi suất không phẩy không năm"),
    ("Tăng 10% so với tuần trước", "Tăng mười phần trăm so với tuần trước"),
    ("Giảm 2,5%", "Giảm hai phẩy năm phần trăm"),
    ("Vé giá 125.000đ", "Vé giá một trăm hai mươi lăm nghìn đồng"),
    ("Vé giá 125.000 đ", "Vé giá một trăm hai mươi lăm nghìn đồng"),
    ("Tổng cộng 5.000.000 VNĐ", "Tổng cộng năm triệu đồng"),
    ("Học phí 2 triệu đồng", "Học phí hai triệu đồng"),
    ("Giá 50.000 đồng", "Giá năm mươi nghìn đồng"),
    ("Chỉ $5 thôi", "Chỉ năm đô la thôi"),
    ("Khoảng 20 USD", "Khoảng hai mươi đô la"),
    ("Ngày 15/8/2026 khai trương", "Ngày mười lăm tháng tám năm hai nghìn không trăm hai mươi sáu khai trương"),
    ("Hạn chót 01/04/2025.", "Hạn chót ngày một tháng tư năm hai nghìn không trăm hai mươi lăm."),
    ("Sinh ngày 2-9-1945", "Sinh ngày hai tháng chín năm một nghìn chín trăm bốn mươi lăm"),
    ("Hẹn gặp 30/4", "Hẹn gặp ngày ba mươi tháng tư"),
    ("Từ tháng 8/2026", "Từ tháng tám năm hai nghìn không trăm hai mươi sáu"),
    ("Khởi hành lúc 7:30", "Khởi hành lúc bảy giờ ba mươi phút"),
    ("Họp lúc 14h", "Họp lúc mười bốn giờ"),
    ("Tan làm lúc 17h30", "Tan làm lúc mười bảy giờ ba mươi phút"),
    ("Bắt đầu 19g15", "Bắt đầu mười chín giờ mười lăm phút"),
    ("Đường dài 5km", "Đường dài năm ki lô mét"),
    ("Tốc độ 60 km/h", "Tốc độ sáu mươi ki lô mét trên giờ"),
    ("Nặng 70kg", "Nặng bảy mươi ki lô gam"),
    ("Thêm 5g muối", "Thêm năm gam muối"),
    ("Căn hộ 75m2", "Căn hộ bảy mươi lăm mét vuông"),
    ("Nhiệt độ 32°C", "Nhiệt độ ba mươi hai độ C"),
    ("Trời lạnh -5°C", "Trời lạnh âm năm độ C"),
    ("Uống 2 l nước", "Uống hai lít nước"),
    ("Cao 1,75 m", "Cao một phẩy bảy mươi lăm mét"),
    ("Ở TP.HCM trời nắng", "Ở thành phố Hồ Chí Minh trời nắng"),
    ("TP. HCM và HN", "thành phố Hồ Chí Minh và Hà Nội"),
    ("Theo UBND phường", "Theo ủy ban nhân dân phường"),
    ("Trường THPT Lê Lợi", "Trường trung học phổ thông Lê Lợi"),
    ("Táo, cam, chuối v.v.", "Táo, cam, chuối vân vân"),
    ("PGS.TS Nguyễn Văn A", "phó giáo sư tiến sĩ Nguyễn Văn A"),
    ("Gọi 0901234567 nhé", "Gọi không chín không một hai ba bốn năm sáu bảy nhé"),
    ("Từ 5-10 người", "Từ năm đến mười người"),
    ("Khoảng 3 – 4 ngày", "Khoảng ba đến bốn ngày"),
    ("Thứ 2 và thứ 4", "Thứ hai và thứ tư"),
    ("Đứng thứ 1", "Đứng thứ nhất"),
    ("Thế kỷ XXI", "Thế kỷ hai mươi mốt"),
    ("Chương IV", "Chương bốn"),
    ("2 + 2 = 4", "hai cộng hai bằng bốn"),
    ("Phòng 3x4", "Phòng ba nhân bốn"),
    ("Tom & Jerry", "Tom và Jerry"),
    ("Năm 2026 là năm mới", "Năm hai nghìn không trăm hai mươi sáu là năm mới"),
    ("Ứng dụng AI", "Ứng dụng ây ai"),
    ("Xin chào!", "Xin chào!"),
    ("Có 21 người và 105 cái ghế", "Có hai mươi mốt người và một trăm linh năm cái ghế"),
]


@pytest.mark.parametrize(("text", "expected"), CASES)
def test_normalize_vi(text, expected):
    assert normalize_vi(text) == expected


def test_user_dictionary_applies_first():
    assert normalize_vi("Dùng EasyVoice", [("EasyVoice", "i di voi")]) == "Dùng i di voi"


def test_user_dictionary_whole_word_only():
    assert normalize_vi("ABC và ABCD", [("ABC", "a bê xê")]) == "a bê xê và ABCD"


def test_case_count():
    assert len(NUMBERS) + len(CASES) >= 50
