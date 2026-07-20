"""MCP client wrapper. Handles both Streamable HTTP (for hosted remote
MCPs like Robinhood) and stdio subprocess (for community MCPs that stay
local, like the Kalshi ones — which sign requests with an RSA key that
never leaves your machine)."""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client

from config import EndpointProfile


@asynccontextmanager
async def open_session(profile: EndpointProfile) -> AsyncIterator[ClientSession]:
    """Open an MCP session for the given profile, dispatching on transport."""
    if profile.transport == "stdio":
        params = StdioServerParameters(
            command=profile.command,
            args=list(profile.args),
            # Inherit full parent env so the subprocess sees anything the
            # user set in .env (e.g. KALSHI_API_KEY, KALSHI_PRIVATE_KEY_PATH).
            env=dict(os.environ),
        )
        async with stdio_client(params) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                yield session
        return

    # Default: Streamable HTTP with optional auth header.
    headers: dict[str, str] = {}
    if profile.auth_header and profile.token:
        headers[profile.auth_header] = f"{profile.auth_prefix}{profile.token}"
    async with streamablehttp_client(profile.url, headers=headers) as (
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
