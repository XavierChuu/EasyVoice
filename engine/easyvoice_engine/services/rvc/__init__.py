"""RVC v2: suy luận (infer.py), nhập model an toàn (import_pth.py). Code kiến trúc vendored ở engine/third_party/rvc."""

import sys
from pathlib import Path

THIRD_PARTY = Path(__file__).resolve().parents[3] / "third_party"
if str(THIRD_PARTY) not in sys.path:
    sys.path.insert(0, str(THIRD_PARTY))
