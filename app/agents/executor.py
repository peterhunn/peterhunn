import asyncio
from datetime import datetime

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.models import AgentType, Chain, ChainStatus, ChainTask, Task, TaskStatus

SUPPORTED_SERVER_TOOLS = {
    "web_search": {"type": "web_search_20260209", "name": "web_search"},
    "web_fetch": {"type": "web_fetch_20260209", "name": "web_fetch"},
}

MAX_PAUSE_CONTINUATIONS = 5


async def execute_task(task_id: int, db: AsyncSession) -> None:
    result = await db.execute(
        select(Task).where(Task.id == task_id).options(selectinload(Task.agent_type))
    )
    task = result.scalar_one_or_none()
    if task is None:
        return

    task.status = TaskStatus.running
    task.updated_at = datetime.utcnow()
    await db.commit()

    try:
        output, token_usage = await _run_agent(task.input, task.agent_type)
        task.output = output
        task.token_usage = token_usage
        task.status = TaskStatus.complete
    except Exception as exc:
        task.error = str(exc)
        task.status = TaskStatus.failed
    finally:
        task.updated_at = datetime.utcnow()
        await db.commit()


async def _run_agent(task_input: str, agent_type: AgentType) -> tuple[str, dict]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _run_agent_sync, task_input, agent_type)


def _run_agent_sync(task_input: str, agent_type: AgentType) -> tuple[str, dict]:
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    tools = _build_tools(agent_type.tools)
    system = [
        {
            "type": "text",
            "text": agent_type.system_prompt,
            "cache_control": {"type": "ephemeral"},
        }
    ]

    params: dict = {
        "model": agent_type.model or settings.default_model,
        "max_tokens": settings.max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": task_input}],
    }
    if tools:
        params["tools"] = tools
    if agent_type.use_thinking:
        params["thinking"] = {"type": "adaptive"}

    total_usage: dict = {"input_tokens": 0, "output_tokens": 0}
    continuations = 0

    while True:
        with client.messages.stream(**params) as stream:
            response = stream.get_final_message()

        total_usage["input_tokens"] += response.usage.input_tokens
        total_usage["output_tokens"] += response.usage.output_tokens

        if response.stop_reason != "pause_turn" or continuations >= MAX_PAUSE_CONTINUATIONS:
            break

        # Server-side tools need another turn
        params["messages"] = [
            *params["messages"],
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": [{"type": "tool_result", "content": "continue"}]},
        ]
        continuations += 1

    text_parts = [block.text for block in response.content if hasattr(block, "text")]
    return "\n".join(text_parts), total_usage


def _build_tools(tool_names: list[str] | None) -> list[dict]:
    if not tool_names:
        return []
    result = []
    for name in tool_names:
        spec = SUPPORTED_SERVER_TOOLS.get(name)
        if spec:
            result.append(spec)
    return result


async def execute_chain(chain_id: int, db: AsyncSession) -> None:
    result = await db.execute(select(Chain).where(Chain.id == chain_id))
    chain = result.scalar_one_or_none()
    if chain is None:
        return

    chain.status = ChainStatus.running
    await db.commit()

    previous_output: str | None = None
    current_input = chain.initial_input

    try:
        for step_order, step_config in enumerate(chain.steps_config):
            agent_type_id = step_config["agent_type_id"]
            input_template = step_config.get("input_template")

            if input_template and previous_output is not None:
                current_input = input_template.format(previous_output=previous_output)
            elif previous_output is not None:
                current_input = previous_output

            agent_result = await db.execute(
                select(AgentType).where(AgentType.id == agent_type_id)
            )
            agent_type = agent_result.scalar_one()

            task = Task(
                agent_type_id=agent_type_id,
                status=TaskStatus.pending,
                input=current_input,
            )
            db.add(task)
            await db.flush()

            chain_task = ChainTask(
                chain_id=chain_id,
                task_id=task.id,
                step_order=step_order,
            )
            db.add(chain_task)
            await db.commit()

            await execute_task(task.id, db)

            # Reload task to get output after execution
            await db.refresh(task)
            if task.status == TaskStatus.failed:
                raise RuntimeError(f"Step {step_order} failed: {task.error}")

            previous_output = task.output

        chain.status = ChainStatus.complete
    except Exception as exc:
        chain.status = ChainStatus.failed
        # Store error on chain by updating the last task or chain record
        _ = exc
    finally:
        chain.updated_at = datetime.utcnow()
        await db.commit()
