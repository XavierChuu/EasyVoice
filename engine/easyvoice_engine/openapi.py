"""In OpenAPI schema ra stdout để sinh types TypeScript (packages/api-types). Không mở port, không cần token.

  python -m easyvoice_engine.openapi > ../packages/api-types/openapi.json
"""

import json
import sys
import tempfile
from pathlib import Path

from .core.state import EngineState
from .main import create_app

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # mô tả tiếng Việt; Windows mặc định cp1252 khi stdout bị chuyển hướng
    state = EngineState.create("openapi", Path(tempfile.mkdtemp()))
    json.dump(create_app(state).openapi(), sys.stdout, indent=2, ensure_ascii=False)
    state.queue.shutdown()
