from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from fastapi import Request, UploadFile

from ..core.state import EngineState


def get_state(request: Request) -> EngineState:
    return request.app.state.engine


def save_upload(state: EngineState, upload: UploadFile) -> Path:
    safe = re.sub(r"[^\w.\-]+", "_", Path(upload.filename or "upload").name)[-80:]
    dest = state.paths.tmp / f"{uuid.uuid4().hex[:8]}_{safe}"
    with dest.open("wb") as f:
        shutil.copyfileobj(upload.file, f)
    return dest
