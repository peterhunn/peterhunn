from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.models import ChainStatus, TaskStatus


# Agent Type schemas

class AgentTypeCreate(BaseModel):
    name: str
    description: str | None = None
    system_prompt: str
    model: str = "claude-opus-4-7"
    tools: list[str] | None = None
    use_thinking: bool = True


class AgentTypeResponse(BaseModel):
    id: int
    name: str
    description: str | None
    system_prompt: str
    model: str
    tools: list[str] | None
    use_thinking: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# Task schemas

class TaskCreate(BaseModel):
    agent_type_id: int
    input: str


class TaskResponse(BaseModel):
    id: int
    agent_type_id: int
    status: TaskStatus
    input: str
    output: str | None
    error: str | None
    token_usage: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# Chain schemas

class ChainStep(BaseModel):
    agent_type_id: int
    input_template: str | None = Field(
        default=None,
        description="Template for step input. Use {previous_output} to inject prior step's result.",
    )


class ChainRunRequest(BaseModel):
    name: str
    initial_input: str
    steps: list[ChainStep] = Field(min_length=1)


class ChainRunResponse(BaseModel):
    chain_id: int
    status: ChainStatus
    task_ids: list[int]

    model_config = {"from_attributes": True}


class ChainResponse(BaseModel):
    id: int
    name: str
    status: ChainStatus
    initial_input: str
    steps_config: list[dict]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
