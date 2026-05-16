from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.agents.executor import execute_chain
from app.database import AsyncSessionLocal, get_db
from app.models import AgentType, Chain, ChainTask
from app.schemas import ChainResponse, ChainRunRequest, ChainRunResponse

router = APIRouter(prefix="/chains", tags=["chains"])


async def _run_chain_background(chain_id: int) -> None:
    async with AsyncSessionLocal() as db:
        await execute_chain(chain_id, db)


@router.post("/", response_model=ChainRunResponse, status_code=202)
async def run_chain(
    body: ChainRunRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    # Validate all agent type IDs upfront
    for step in body.steps:
        result = await db.execute(select(AgentType).where(AgentType.id == step.agent_type_id))
        if result.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=404,
                detail=f"Agent type {step.agent_type_id} not found",
            )

    steps_config = [
        {"agent_type_id": s.agent_type_id, "input_template": s.input_template}
        for s in body.steps
    ]
    chain = Chain(
        name=body.name,
        initial_input=body.initial_input,
        steps_config=steps_config,
    )
    db.add(chain)
    await db.commit()
    await db.refresh(chain)

    background_tasks.add_task(_run_chain_background, chain.id)

    return ChainRunResponse(chain_id=chain.id, status=chain.status, task_ids=[])


@router.get("/", response_model=list[ChainResponse])
async def list_chains(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Chain).order_by(Chain.id.desc()))
    return result.scalars().all()


@router.get("/{chain_id}", response_model=ChainResponse)
async def get_chain(chain_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Chain).where(Chain.id == chain_id))
    chain = result.scalar_one_or_none()
    if chain is None:
        raise HTTPException(status_code=404, detail="Chain not found")
    return chain


@router.get("/{chain_id}/tasks", response_model=list[int])
async def get_chain_tasks(chain_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Chain).where(Chain.id == chain_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Chain not found")

    ct_result = await db.execute(
        select(ChainTask)
        .where(ChainTask.chain_id == chain_id)
        .order_by(ChainTask.step_order)
        .options(selectinload(ChainTask.task))
    )
    return [ct.task_id for ct in ct_result.scalars().all()]
