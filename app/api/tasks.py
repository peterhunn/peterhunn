from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.executor import execute_task
from app.database import AsyncSessionLocal, get_db
from app.models import AgentType, Task
from app.schemas import TaskCreate, TaskResponse

router = APIRouter(prefix="/tasks", tags=["tasks"])


async def _run_task_background(task_id: int) -> None:
    async with AsyncSessionLocal() as db:
        await execute_task(task_id, db)


@router.post("/", response_model=TaskResponse, status_code=202)
async def create_task(
    body: TaskCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    agent_result = await db.execute(select(AgentType).where(AgentType.id == body.agent_type_id))
    if agent_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Agent type not found")

    task = Task(agent_type_id=body.agent_type_id, input=body.input)
    db.add(task)
    await db.commit()
    await db.refresh(task)

    background_tasks.add_task(_run_task_background, task.id)
    return task


@router.get("/", response_model=list[TaskResponse])
async def list_tasks(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Task).order_by(Task.id.desc()))
    return result.scalars().all()


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(task_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task
