from easyvoice_engine.services.tts.ref_prep import MAX_SEC, pick_cut


def _words(spec):
    """spec: list of (start, end, text)."""
    return [(float(a), float(b), t) for a, b, t in spec]


def test_longest_pause_bounded_within_limit():
    w = _words([(0, 2, "Hello"), (2.05, 4.5, "there."), (5.0, 7, "This"), (7.05, 9.8, "is"), (10.3, 10.9, "long"),
                (11.0, 13, "speech.")])
    assert pick_cut(w) == 4  # "is" (9.8 s, khe 0.5 s) thắng "there." (4.5 s); "long" không có khe ngắt


def test_sentence_end_wins_when_close():
    w = _words([(0, 4, "One"), (4.05, 8.6, "two."), (9.0, 9.4, "three"), (9.6, 9.9, "four"), (9.92, 12, "five")])
    assert pick_cut(w) == 2  # "two." (8.6 s + điểm cuối câu) thắng "three" (9.4 s); "four" không có khe ngắt


def test_cuts_at_pause_not_mid_phrase():
    w = _words([(0, 3, "a"), (3.02, 6, "b"), (6.5, 9.0, "c"), (9.02, 10.5, "d"), (10.52, 12, "e")])
    assert pick_cut(w) == 2  # khe 0.5 s sau "b" là chỗ ngắt duy nhất trong giới hạn


def test_fallback_without_pause():
    w = _words([(i, i + 0.99, "x") for i in range(20)])
    n = pick_cut(w)
    assert 0 < n and w[n - 1][1] <= MAX_SEC


def test_empty():
    assert pick_cut([]) == 0
