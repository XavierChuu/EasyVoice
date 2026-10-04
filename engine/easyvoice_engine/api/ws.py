from __future__ import annotations

import asyncio
import hmac

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..core.state import EngineState

router = APIRouter()


@router.websocket("/ws/jobs")
async def ws_jobs(ws: WebSocket, token: str = "") -> None:
    state: EngineState = ws.app.state.engine
    if not hmac.compare_digest(token, state.token):
        await ws.close(code=4401)
        return
    await ws.accept()
    q = state.hub.subscribe()
    try:
        for job in list(state.queue.jobs.values()):
            await ws.send_json({"type": "job", "job": job.model_dump(by_alias=True)})
        state.publish_voices()
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=15)
            except asyncio.TimeoutError:
                event = {"type": "ping"}
            await ws.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        state.hub.unsubscribe(q)
