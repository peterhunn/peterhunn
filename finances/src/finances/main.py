"""App entry — mounts REST + web UI + MCP under one FastAPI process."""

from __future__ import annotations

from fastapi import FastAPI

from .api import build_api
from .config import Config
from .mcp_server import build_mcp


def build_app(cfg: Config) -> FastAPI:
    app = build_api(cfg)
    mcp = build_mcp(cfg)
    # FastMCP exposes an ASGI app at .streamable_http_app() (over MCP HTTP).
    app.mount("/mcp", mcp.streamable_http_app())
    return app
