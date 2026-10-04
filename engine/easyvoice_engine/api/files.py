from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse

from ..core.errors import EngineError
from ..core.state import EngineState
from .deps import get_state

router = APIRouter(tags=["files"])


@router.get("/files/{file_id}", response_class=FileResponse)
def get_file(file_id: str, download: bool = False, state: EngineState = Depends(get_state)) -> FileResponse:
    item = state.files.get(file_id)
    if not item or not item[0].exists():
        raise EngineError("NOT_FOUND", f"file {file_id}")
    path, name = item
    return FileResponse(path, filename=name if download else None,
                        content_disposition_type="attachment" if download else "inline")
