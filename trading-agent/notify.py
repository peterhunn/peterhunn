"""Best-effort webhook notifications for notable run events.

Payload shape is Slack-compatible (`text` field) so a Slack incoming
webhook works with no adapter. The full structured payload is sent too;
custom receivers can key on `event`.

Failures never break the run — they log to stderr and move on.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

import httpx


NOTIFY_TIMEOUT_S = 5.0


def _fmt(endpoint: str, strategy: str | None, event: str, message: str) -> str:
    tag = f"[{endpoint}"
    if strategy:
        tag += f"/{strategy}"
    tag += f"] {event.upper()}"
    return f"{tag}: {message}"


async def post(
    webhook_url: str | None,
    endpoint: str,
    strategy: str | None,
    event: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> None:
    """Fire-and-forget-ish: awaited but with a short timeout. Never raises."""
    if not webhook_url:
        return
    payload = {
        "text": _fmt(endpoint, strategy, event, message),
        "endpoint": endpoint,
        "strategy": strategy,
        "event": event,
        "message": message,
        "details": details or {},
    }
    try:
        async with httpx.AsyncClient(timeout=NOTIFY_TIMEOUT_S) as client:
            r = await client.post(webhook_url, json=payload)
        if r.status_code >= 400:
            print(
                f"[notify] webhook returned {r.status_code}: {r.text[:200]}",
                file=sys.stderr,
            )
    except Exception as exc:
        print(f"[notify] failed: {exc}", file=sys.stderr)


def fire_and_forget(
    webhook_url: str | None,
    endpoint: str,
    strategy: str | None,
    event: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> asyncio.Task | None:
    """Schedule a notification as an asyncio Task. Returns the task so the
    caller can await it (e.g. at run end). Returns None if no webhook set."""
    if not webhook_url:
        return None
    return asyncio.create_task(
        post(webhook_url, endpoint, strategy, event, message, details)
    )
