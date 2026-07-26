"""Configuration split into two layers:

- GlobalConfig: things that apply to every run (Anthropic key, model,
  effort, DRY_RUN).
- EndpointProfile: things that apply to one MCP endpoint.

Endpoints are declared in `endpoints.yaml` at the package root. Load a
profile by name with `load_endpoint(name)`.

Transports:
    transport: "http"   (default) — Streamable HTTP; needs url + auth
    transport: "stdio"  — local subprocess; needs command + args
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).parent

VALID_TRANSPORTS = ("http", "stdio")


@dataclass(frozen=True)
class GlobalConfig:
    anthropic_api_key: str
    model: str
    effort: str
    dry_run: bool


@dataclass(frozen=True)
class Strategy:
    name: str
    endpoint: str
    prompt_addendum: str
    initial_instruction: str = ""
    enabled: bool = True


@dataclass(frozen=True)
class EndpointProfile:
    name: str
    transport: str
    prompt_file: Path
    journal_file: Path
    write_markers: tuple[str, ...] = ()
    max_writes_per_run: int | None = None
    notional_cap_usd: float | None = None
    # HTTP transport
    url: str = ""
    token: str = ""
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer "
    # stdio transport
    command: str = ""
    args: tuple[str, ...] = ()
    extra: dict[str, Any] = field(default_factory=dict)

    def read_prompt(self) -> str:
        return self.prompt_file.read_text(encoding="utf-8")

    def location(self) -> str:
        """Human-readable identifier for logs."""
        if self.transport == "stdio":
            return f"stdio: {self.command} {' '.join(self.args)}".rstrip()
        return f"http: {self.url}"


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(
            f"Missing required env var {name}. Copy .env.example to .env and fill it in."
        )
    return value


def load_global() -> GlobalConfig:
    return GlobalConfig(
        anthropic_api_key=_require_env("ANTHROPIC_API_KEY"),
        model=os.environ.get("MODEL", "claude-opus-4-8").strip(),
        effort=os.environ.get("EFFORT", "high").strip(),
        dry_run=os.environ.get("DRY_RUN", "true").strip().lower() != "false",
    )


def _load_registry() -> dict[str, dict[str, Any]]:
    path = ROOT / "endpoints.yaml"
    if not path.exists():
        raise RuntimeError(f"endpoints.yaml not found at {path}")
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    endpoints = doc.get("endpoints") or {}
    if not isinstance(endpoints, dict):
        raise RuntimeError("endpoints.yaml must define a top-level `endpoints:` mapping")
    return endpoints


def list_endpoints() -> list[str]:
    return sorted(_load_registry().keys())


def _load_strategy_registry() -> dict[str, dict[str, Any]]:
    path = ROOT / "strategies.yaml"
    if not path.exists():
        return {}
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    strategies = doc.get("strategies") or {}
    if not isinstance(strategies, dict):
        raise RuntimeError("strategies.yaml must define a top-level `strategies:` mapping")
    return strategies


def list_strategies() -> list[str]:
    return sorted(_load_strategy_registry().keys())


def strategies_index() -> list[dict[str, Any]]:
    """Return metadata for every strategy: name, endpoint, enabled."""
    out = []
    for name in sorted(_load_strategy_registry().keys()):
        raw = _load_strategy_registry()[name]
        out.append({
            "name": name,
            "endpoint": raw.get("endpoint", ""),
            "enabled": bool(raw.get("enabled", True)),
        })
    return out


def set_strategy_enabled(name: str, enabled: bool) -> None:
    """Toggle a strategy's enabled flag by rewriting strategies.yaml.
    Preserves everything else about the file."""
    path = ROOT / "strategies.yaml"
    if not path.exists():
        raise RuntimeError("strategies.yaml not found")
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    strategies = doc.get("strategies") or {}
    if name not in strategies:
        raise RuntimeError(f"strategy '{name}' not found in strategies.yaml")
    strategies[name]["enabled"] = bool(enabled)
    path.write_text(
        yaml.safe_dump(doc, sort_keys=False, default_flow_style=False, width=100),
        encoding="utf-8",
    )


def load_strategy(name: str) -> Strategy:
    registry = _load_strategy_registry()
    if name not in registry:
        available = ", ".join(sorted(registry.keys())) or "(none)"
        raise RuntimeError(
            f"Strategy '{name}' not found in strategies.yaml. Available: {available}"
        )
    raw = registry[name]
    endpoint = raw.get("endpoint")
    addendum = raw.get("prompt_addendum", "")
    if not endpoint or not addendum:
        raise RuntimeError(
            f"Strategy '{name}' is missing endpoint or prompt_addendum"
        )
    # Verify the endpoint is real (fail fast, before opening any session).
    if endpoint not in _load_registry():
        raise RuntimeError(
            f"Strategy '{name}' references endpoint '{endpoint}' which is "
            "not declared in endpoints.yaml."
        )
    enabled_raw = raw.get("enabled", True)
    return Strategy(
        name=name,
        endpoint=endpoint,
        prompt_addendum=str(addendum),
        initial_instruction=str(raw.get("initial_instruction", "")),
        enabled=bool(enabled_raw),
    )


def load_endpoint(name: str) -> EndpointProfile:
    registry = _load_registry()
    if name not in registry:
        available = ", ".join(sorted(registry.keys())) or "(none)"
        raise RuntimeError(
            f"Endpoint '{name}' not found in endpoints.yaml. Available: {available}"
        )
    raw = registry[name]

    prompt_file = raw.get("prompt_file")
    journal_file = raw.get("journal_file")
    if not (prompt_file and journal_file):
        raise RuntimeError(
            f"Endpoint '{name}' is missing prompt_file or journal_file"
        )

    transport = raw.get("transport", "http")
    if transport not in VALID_TRANSPORTS:
        raise RuntimeError(
            f"Endpoint '{name}' has invalid transport '{transport}'. "
            f"Valid: {', '.join(VALID_TRANSPORTS)}"
        )

    url = ""
    token = ""
    auth_header = raw.get("auth_header", "Authorization")
    auth_prefix = raw.get("auth_prefix", "Bearer ")
    command = ""
    args: tuple[str, ...] = ()

    if transport == "http":
        url = raw.get("url", "")
        if not url:
            raise RuntimeError(f"Endpoint '{name}' (http) requires url")
        token_env = raw.get("token_env")
        if auth_header:
            if not token_env:
                raise RuntimeError(
                    f"Endpoint '{name}' has an auth_header but no token_env. "
                    "Set token_env, or set auth_header: '' to disable auth."
                )
            token = _require_env(token_env)

    elif transport == "stdio":
        command = raw.get("command", "")
        if not command:
            raise RuntimeError(f"Endpoint '{name}' (stdio) requires command")
        raw_args = raw.get("args") or []
        if not isinstance(raw_args, list):
            raise RuntimeError(f"Endpoint '{name}' args must be a list of strings")
        args = tuple(str(a) for a in raw_args)

    markers = tuple(str(m).lower() for m in (raw.get("write_markers") or []))
    max_writes = raw.get("max_writes_per_run")
    notional_cap = raw.get("notional_cap_usd")

    prompt_path = (ROOT / prompt_file).resolve()
    journal_path = (ROOT / journal_file).resolve()

    consumed = {
        "url", "token_env", "prompt_file", "journal_file",
        "write_markers", "max_writes_per_run", "notional_cap_usd",
        "auth_header", "auth_prefix", "transport", "command", "args",
    }

    return EndpointProfile(
        name=name,
        transport=transport,
        prompt_file=prompt_path,
        journal_file=journal_path,
        write_markers=markers,
        max_writes_per_run=int(max_writes) if max_writes is not None else None,
        notional_cap_usd=float(notional_cap) if notional_cap is not None else None,
        url=url,
        token=token,
        auth_header=auth_header,
        auth_prefix=auth_prefix,
        command=command,
        args=args,
        extra={k: v for k, v in raw.items() if k not in consumed},
    )
