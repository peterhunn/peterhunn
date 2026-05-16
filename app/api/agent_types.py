from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import AgentType
from app.schemas import AgentTypeCreate, AgentTypeResponse

router = APIRouter(prefix="/agent-types", tags=["agent-types"])


@router.post("/", response_model=AgentTypeResponse, status_code=201)
async def create_agent_type(body: AgentTypeCreate, db: AsyncSession = Depends(get_db)):
    agent_type = AgentType(**body.model_dump())
    db.add(agent_type)
    await db.commit()
    await db.refresh(agent_type)
    return agent_type


@router.get("/", response_model=list[AgentTypeResponse])
async def list_agent_types(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AgentType).order_by(AgentType.id))
    return result.scalars().all()


@router.get("/{agent_type_id}", response_model=AgentTypeResponse)
async def get_agent_type(agent_type_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AgentType).where(AgentType.id == agent_type_id))
    agent_type = result.scalar_one_or_none()
    if agent_type is None:
        raise HTTPException(status_code=404, detail="Agent type not found")
    return agent_type


@router.delete("/{agent_type_id}", status_code=204)
async def delete_agent_type(agent_type_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AgentType).where(AgentType.id == agent_type_id))
    agent_type = result.scalar_one_or_none()
    if agent_type is None:
        raise HTTPException(status_code=404, detail="Agent type not found")
    await db.delete(agent_type)
    await db.commit()
