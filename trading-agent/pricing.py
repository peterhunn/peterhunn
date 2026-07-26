"""Model pricing table + cost helper. Kept small on purpose — update the
table when Anthropic's list price shifts. Cached from platform.claude.com
docs; rerun that lookup periodically if the numbers matter to your P&L.

Rates are USD per 1M tokens. cache_write assumes 5-minute TTL (the
default); 1-hour cache writes are 2x input, not modeled here.
"""

from __future__ import annotations

from typing import Any

# {model_id: {kind: usd_per_million}}
PRICING: dict[str, dict[str, float]] = {
    "claude-fable-5":    {"input": 10.0, "output": 50.0, "cache_read": 1.0,  "cache_write": 12.5},
    "claude-opus-4-8":   {"input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_write": 6.25},
    "claude-opus-4-7":   {"input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_write": 6.25},
    "claude-opus-4-6":   {"input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_write": 6.25},
    "claude-sonnet-5":   {"input": 3.0,  "output": 15.0, "cache_read": 0.3,  "cache_write": 3.75},
    "claude-sonnet-4-6": {"input": 3.0,  "output": 15.0, "cache_read": 0.3,  "cache_write": 3.75},
    "claude-haiku-4-5":  {"input": 1.0,  "output": 5.0,  "cache_read": 0.1,  "cache_write": 1.25},
}

_FALLBACK = PRICING["claude-opus-4-8"]


def rates(model: str) -> dict[str, float]:
    return PRICING.get(model, _FALLBACK)


def cost_usd(model: str, usage: dict[str, Any]) -> float:
    """Compute USD cost from a usage dict (Anthropic Message.usage fields)."""
    r = rates(model)
    return (
        int(usage.get("input_tokens", 0)) * r["input"]
        + int(usage.get("output_tokens", 0)) * r["output"]
        + int(usage.get("cache_read_input_tokens", 0)) * r["cache_read"]
        + int(usage.get("cache_creation_input_tokens", 0)) * r["cache_write"]
    ) / 1_000_000
