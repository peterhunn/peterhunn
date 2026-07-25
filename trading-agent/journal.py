"""Append-only JSONL journal of every run. The journal is the agent's
memory across runs: on start-up, the last N entries are rendered into the
system prompt so the model can pick up where it left off.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


JOURNAL_LOAD_ENTRIES = 60
JOURNAL_SUMMARY_MAX_CHARS = 3200


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Journal:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, entry: dict[str, Any]) -> None:
        entry = {"ts": _now_iso(), **entry}
        line = json.dumps(entry, default=str, ensure_ascii=False)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    def recent(
        self,
        n: int = JOURNAL_LOAD_ENTRIES,
        strategy: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return the last N entries. If `strategy` is set, filter to only
        events from runs tagged with that strategy — we walk the file back
        to front and include entries whose enclosing run had a matching
        strategy tag on its `run_start`.
        """
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        parsed: list[dict[str, Any]] = []
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            try:
                parsed.append(json.loads(raw))
            except json.JSONDecodeError:
                continue

        if strategy is None:
            return parsed[-n:]

        # Bucket by run_start → run_end and keep runs whose start matched.
        out: list[dict[str, Any]] = []
        keeping = False
        for e in parsed:
            t = e.get("type")
            if t == "run_start":
                keeping = e.get("strategy") == strategy
            if keeping:
                out.append(e)
            if t == "run_end":
                keeping = False
        return out[-n:]


def render_history(entries: list[dict[str, Any]]) -> str:
    """Compact, model-facing summary of past runs. Deliberately terse — this
    goes into the system prompt on every call, so keep it dense and factual.
    """
    if not entries:
        return ""

    lines: list[str] = []
    for e in entries:
        t = e.get("type")
        ts = e.get("ts", "")
        if t == "run_start":
            strat = f" strategy={e['strategy']}" if e.get("strategy") else ""
            lines.append(
                f"[{ts}] RUN mode={e.get('mode')}{strat} — "
                f"{e.get('instruction','')[:120]}"
            )
        elif t == "tool_call":
            args = json.dumps(e.get("args", {}), default=str)[:140]
            res = str(e.get("result_summary", ""))[:160]
            lines.append(f"  call {e.get('tool')} args={args} -> {res}")
        elif t == "tool_blocked":
            lines.append(
                f"  BLOCKED {e.get('tool')} args={json.dumps(e.get('args', {}), default=str)[:140]} "
                f"reason={e.get('reason','')[:120]}"
            )
        elif t == "tool_error":
            lines.append(f"  ERROR {e.get('tool')} — {str(e.get('error',''))[:160]}")
        elif t == "refusal":
            lines.append(f"  MODEL REFUSAL category={e.get('category')} explanation={e.get('explanation','')[:120]}")
        elif t == "run_end":
            summary = str(e.get("final_text", ""))[:400]
            if summary:
                lines.append(f"  end: {summary}")
        # Skip unknown types silently

    body = "\n".join(lines)
    if len(body) > JOURNAL_SUMMARY_MAX_CHARS:
        # Keep the tail — recency matters most
        body = "…(older entries truncated)…\n" + body[-JOURNAL_SUMMARY_MAX_CHARS:]
    return body
