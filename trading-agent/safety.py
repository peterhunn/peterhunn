"""Endpoint-driven safety gate. Each tool call is classified read vs. write
by the endpoint's `write_markers`; writes are then checked against the
endpoint's per-run count cap, optional notional cap, and global DRY_RUN.
Refused calls return a `Decision(allowed=False, reason=...)` — the caller
turns that into a synthetic tool_result so Claude can adapt.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from config import EndpointProfile, GlobalConfig


def is_write_tool(name: str, markers: tuple[str, ...]) -> bool:
    if not markers:
        return False
    n = name.lower()
    return any(m in n for m in markers)


# Conservative allowlist used by the read-only override. When
# SafetyGate.read_only is True, any tool whose name does not match one of
# these markers is refused — regardless of the endpoint's write_markers
# config. This is the belt-and-suspenders check for --propose-strategy and
# --reflect, where dry-run is already forced but we want to guarantee no
# writes even against a misconfigured endpoint whose write_markers list is
# incomplete.
READ_TOOL_MARKERS: tuple[str, ...] = (
    "get_",
    "list_",
    "search_",
    "find_",
    "read_",
    "view_",
    "check_",
    "describe_",
    "lookup_",
    "fetch_",
    "quote_",
    "info_",
    "show_",
    "count_",
    "has_",
    "is_",
    "browse_",
    "scan_",
)


def is_read_only_tool(name: str) -> bool:
    n = name.lower()
    return any(m in n for m in READ_TOOL_MARKERS)


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
    """Best-effort notional from tool args. Currently only applies to
    trading endpoints — other domains leave notional_cap_usd unset and
    this function is never consulted.
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
    def __init__(
        self,
        profile: EndpointProfile,
        global_cfg: GlobalConfig,
        read_only: bool = False,
    ) -> None:
        self.profile = profile
        self.global_cfg = global_cfg
        self.read_only = read_only
        self.writes_used = 0

    def check(self, tool_name: str, args: dict[str, Any]) -> Decision:
        # Read-only mode: whitelist by name. If the tool name doesn't
        # look like a read, refuse — regardless of write_markers config.
        if self.read_only and not is_read_only_tool(tool_name):
            return Decision(
                False,
                "read-only mode is on for this run "
                "(--propose-strategy or --reflect). Only tools whose "
                "names match the read allowlist are permitted.",
            )

        if not is_write_tool(tool_name, self.profile.write_markers):
            return Decision(True)

        if self.global_cfg.dry_run:
            return Decision(
                False,
                "DRY_RUN is on for this run; write tools are disabled. "
                "Describe the action you would take instead.",
            )

        cap = self.profile.max_writes_per_run
        if cap is not None and self.writes_used >= cap:
            return Decision(
                False,
                f"max_writes_per_run ({cap}) already reached for endpoint "
                f"'{self.profile.name}'. Stop and produce a summary.",
            )

        if self.profile.notional_cap_usd is not None:
            notional = compute_notional(args)
            if notional is None:
                return Decision(
                    False,
                    "harness could not compute notional from these arguments. "
                    "Supply an explicit quantity and limit_price so the "
                    "notional cap can be validated.",
                )
            if notional > self.profile.notional_cap_usd:
                return Decision(
                    False,
                    f"notional ${notional:.2f} exceeds notional_cap_usd "
                    f"(${self.profile.notional_cap_usd:.2f}). Reduce "
                    "quantity or limit price.",
                )

        return Decision(True)

    def record_allowed_write(self) -> None:
        self.writes_used += 1
