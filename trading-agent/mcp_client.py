"""Streamable HTTP MCP client wrapper. Works with any MCP server that
speaks the Streamable HTTP transport and accepts a bearer token."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


@asynccontextmanager
async def open_session(url: str, bearer_token: str) -> AsyncIterator[ClientSession]:
    headers = {"Authorization": f"Bearer {bearer_token}"}
    async with streamablehttp_client(url, headers=headers) as (
        read_stream,
        write_stream,
        _get_session_id,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            yield session


def to_anthropic_tool(mcp_tool: Any) -> dict[str, Any]:
    schema = mcp_tool.inputSchema or {"type": "object", "properties": {}}
    return {
        "name": mcp_tool.name,
        "description": mcp_tool.description or "",
        "input_schema": schema,
    }


def render_tool_result(result: Any) -> str:
    parts: list[str] = []
    for item in getattr(result, "content", []) or []:
        text = getattr(item, "text", None)
        if text is not None:
            parts.append(text)
            continue
        try:
            parts.append(json.dumps(item.model_dump(), default=str))
        except Exception:
            parts.append(repr(item))
    joined = "\n".join(parts).strip()
    return joined or "(no content)"
