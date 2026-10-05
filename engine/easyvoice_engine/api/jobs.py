from __future__ import annotations

from fastapi import APIRouter, Depends

from ..core.errors import EngineError
from ..core.state import EngineState
from ..schemas import Job
from .deps import get_state

router = APIRouter(tags=["jobs"])


@router.get("/jobs", response_model=list[Job])
def list_jobs(state: EngineState = Depends(get_state)) -> list[Job]:
    return sorted(state.queue.jobs.values(), key=lambda j: j.created_at)


@router.get("/jobs/{job_id}", response_model=Job)
def get_job(job_id: str, state: EngineState = Depends(get_state)) -> Job:
    return state.queue.get(job_id)


@router.delete("/jobs/{job_id}", response_model=Job)
def cancel_job(job_id: str, state: EngineState = Depends(get_state)) -> Job:
    return state.queue.cancel(job_id)


@router.post("/jobs/{job_id}/resume", response_model=Job)
def resume_job(job_id: str, state: EngineState = Depends(get_state)) -> Job:
    from .train import resume_training

    job = state.queue.get(job_id)
    if job.kind != "train":
        raise EngineError("BAD_REQUEST", "chỉ tiếp tục được job huấn luyện")
    return resume_training(state, job)
