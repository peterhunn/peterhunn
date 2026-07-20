"""Local MCP client for Robinhood's Agentic Trading MCP server.

Exposes an async context manager `open_session(token)` that yields an
initialized ClientSession you can call `list_tools()` and `call_tool()` on.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from config import ROBINHOOD_MCP_URL


@asynccontextmanager
async def open_session(bearer_token: str) -> AsyncIterator[ClientSession]:
    headers = {"Authorization": f"Bearer {bearer_token}"}
    async with streamablehttp_client(ROBINHOOD_MCP_URL, headers=headers) as (
        read_stream,
        write_stream,
        _get_session_id,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            yield session


def to_anthropic_tool(mcp_tool: Any) -> dict[str, Any]:
    """Convert an MCP Tool object to an Anthropic tool definition."""
    schema = mcp_tool.inputSchema or {"type": "object", "properties": {}}
    return {
        "name": mcp_tool.name,
        "description": mcp_tool.description or "",
        "input_schema": schema,
    }


def render_tool_result(result: Any) -> str:
    """Render an MCP CallToolResult's content list as a single string for
    Claude. MCP content blocks are TextContent / ImageContent / EmbeddedResource;
    we serialize text and stringify the rest.
    """
    parts: list[str] = []
    for item in getattr(result, "content", []) or []:
        text = getattr(item, "text", None)
        if text is not None:
            parts.append(text)
            continue
        # Fallback: dump whatever it is
        try:
            parts.append(json.dumps(item.model_dump(), default=str))
        except Exception:
            parts.append(repr(item))
    joined = "\n".join(parts).strip()
    return joined or "(no content)"
