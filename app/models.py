import enum
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class TaskStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    complete = "complete"
    failed = "failed"


class ChainStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    complete = "complete"
    failed = "failed"


class AgentType(Base):
    __tablename__ = "agent_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    system_prompt: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(String(100))
    tools: Mapped[list | None] = mapped_column(JSON, nullable=True)
    use_thinking: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    tasks: Mapped[list["Task"]] = relationship("Task", back_populates="agent_type")


class Chain(Base):
    __tablename__ = "chains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    status: Mapped[ChainStatus] = mapped_column(Enum(ChainStatus), default=ChainStatus.pending)
    initial_input: Mapped[str] = mapped_column(Text)
    steps_config: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    chain_tasks: Mapped[list["ChainTask"]] = relationship(
        "ChainTask", back_populates="chain", order_by="ChainTask.step_order"
    )


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    agent_type_id: Mapped[int] = mapped_column(Integer, ForeignKey("agent_types.id"))
    status: Mapped[TaskStatus] = mapped_column(Enum(TaskStatus), default=TaskStatus.pending)
    input: Mapped[str] = mapped_column(Text)
    output: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    token_usage: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    agent_type: Mapped[AgentType] = relationship("AgentType", back_populates="tasks")
    chain_task: Mapped["ChainTask | None"] = relationship("ChainTask", back_populates="task", uselist=False)


class ChainTask(Base):
    __tablename__ = "chain_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    chain_id: Mapped[int] = mapped_column(Integer, ForeignKey("chains.id"))
    task_id: Mapped[int] = mapped_column(Integer, ForeignKey("tasks.id"))
    step_order: Mapped[int] = mapped_column(Integer)

    chain: Mapped[Chain] = relationship("Chain", back_populates="chain_tasks")
    task: Mapped[Task] = relationship("Task", back_populates="chain_task")
