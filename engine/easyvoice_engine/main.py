"""Khởi tạo app FastAPI. Chỉ bind 127.0.0.1, port động, token qua biến môi trường EASYVOICE_TOKEN (spec mục 10).

  EASYVOICE_TOKEN=dev python -m easyvoice_engine.main --port 8765
"""

from __future__ import annotations

import argparse
import hmac
import logging
import os
import secrets
import socket
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .api import files, jobs, sts, system, tts, voices, ws
from .core.errors import EngineError, from_exception
from .core.state import EngineState

OPEN_PATHS = {"/docs", "/openapi.json", "/docs/oauth2-redirect"}


def create_app(state: EngineState) -> FastAPI:
    app = FastAPI(title="EasyVoice Engine", version=__version__,
                  description="API local của EasyVoice. Mọi request cần header `Authorization: Bearer <token>`.")
    app.state.engine = state
    # Renderer Electron (file:// hoặc Vite dev) gọi sang 127.0.0.1 — token mới là lớp bảo vệ.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if request.method == "OPTIONS" or request.url.path in OPEN_PATHS:
            return await call_next(request)
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token", "")
        if not hmac.compare_digest(token, state.token):
            return JSONResponse(EngineError("UNAUTHORIZED").to_dict(), status_code=401)
        return await call_next(request)

    @app.exception_handler(EngineError)
    async def engine_error(_req: Request, exc: EngineError):
        return JSONResponse(exc.to_dict(), status_code=exc.status)

    @app.exception_handler(Exception)
    async def unknown_error(_req: Request, exc: Exception):
        logging.getLogger("easyvoice").exception("unhandled error")
        err = from_exception(exc)
        return JSONResponse(err.to_dict(), status_code=err.status)

    for r in (system.router, voices.router, tts.router, sts.router, jobs.router, files.router, ws.router):
        app.include_router(r)
    return app


def setup_logging(log_dir: Path) -> None:
    handler = RotatingFileHandler(log_dir / "engine.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler(sys.stderr)])


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    ap = argparse.ArgumentParser(description="EasyVoice engine")
    ap.add_argument("--port", type=int, default=0, help="0 = tự chọn port trống")
    ap.add_argument("--data-dir", help="thư mục dữ liệu (mặc định theo OS, hoặc EASYVOICE_DATA_DIR)")
    args = ap.parse_args()
    token = os.environ.get("EASYVOICE_TOKEN") or secrets.token_hex(24)
    state = EngineState.create(token, Path(args.data_dir) if args.data_dir else None)
    setup_logging(state.paths.logs)
    port = args.port or free_port()
    if not os.environ.get("EASYVOICE_TOKEN"):
        print(f"EASYVOICE_TOKEN={token}", flush=True)
    print(f"EASYVOICE_READY port={port} data={state.paths.root} device={state.device()}", flush=True)
    import uvicorn

    uvicorn.run(create_app(state), host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
