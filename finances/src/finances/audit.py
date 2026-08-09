"""Append-only audit log for MCP tool invocations."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def log(path: Path, tool: str, args: dict, result_summary: str) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tool": tool,
        "args": args,
        "result": result_summary,
    }
    with path.open("a") as f:
        f.write(json.dumps(entry, default=str) + "\n")
