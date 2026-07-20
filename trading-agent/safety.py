"""Harness-level safety checks. The agent's system prompt describes limits;
this module ENFORCES them by intercepting each tool call before it reaches
the MCP server. If a check fails, the tool call is refused and an error
result is returned to Claude so it can adapt.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from config import Config


WRITE_TOOL_MARKERS: tuple[str, ...] = (
    "place_",
    "submit_",
    "cancel_",
    "modify_",
    "replace_order",
    "create_order",
    "buy",
    "sell",
)


def is_write_tool(name: str) -> bool:
    """Heuristic: treat any tool whose name suggests order mutation as WRITE.

    Robinhood's exact tool set is discovered at connect time; this catches
    the common naming patterns. Anything else is READ-only. Erring on the
    side of "WRITE" only affects tool calls that touch orders anyway.
    """
    n = name.lower()
    return any(marker in n for marker in WRITE_TOOL_MARKERS)


def _pick(args: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in args and args[k] is not None:
            return args[k]
    return None


def _to_float(x: Any) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def compute_notional(args: dict[str, Any]) -> float | None:
    """Compute notional dollar size from tool arguments. Returns None when
    the harness cannot determine the size (e.g. a market order with no price
    hint), which callers treat as unsafe.
    """
    qty = _to_float(_pick(args, "quantity", "qty", "shares", "amount"))
    price = _to_float(
        _pick(args, "limit_price", "price", "estimated_price", "expected_price")
    )
    if qty is None or price is None:
        return None
    return abs(qty * price)


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str = ""


class SafetyGate:
    """Per-run gate — tracks how many WRITE calls have been allowed so far
    and enforces the trade-count cap. Not thread-safe (a single-run agent
    loop is sequential).
    """

    def __init__(self, config: Config) -> None:
        self.config = config
        self.writes_used = 0

    def check(self, tool_name: str, args: dict[str, Any]) -> Decision:
        if not is_write_tool(tool_name):
            return Decision(True)

        if self.config.dry_run:
            return Decision(
                False,
                "DRY_RUN is on for this run; order-mutating tools are disabled. "
                "Describe the trade you would place instead.",
            )

        if self.writes_used >= self.config.max_trades_per_run:
            return Decision(
                False,
                f"MAX_TRADES_PER_RUN ({self.config.max_trades_per_run}) already "
                "reached. Stop trading and produce the trade log.",
            )

        notional = compute_notional(args)
        if notional is None:
            return Decision(
                False,
                "harness could not compute notional from these arguments. "
                "Supply an explicit limit_price and quantity so the notional "
                "cap can be validated.",
            )
        if notional > self.config.max_notional_per_trade_usd:
            return Decision(
                False,
                f"notional ${notional:.2f} exceeds MAX_NOTIONAL_PER_TRADE_USD "
                f"(${self.config.max_notional_per_trade_usd:.2f}). Reduce "
                "quantity or limit price.",
            )
        return Decision(True)

    def record_allowed_write(self) -> None:
        self.writes_used += 1
