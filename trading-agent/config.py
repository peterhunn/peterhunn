"""Configuration split into two layers:

- GlobalConfig: things that apply to every run (Anthropic key, model,
  effort, DRY_RUN).
- EndpointProfile: things that apply to one MCP endpoint (URL, token,
  prompt file, write markers, per-run caps, journal path).

Endpoints are declared in `endpoints.yaml` at the package root. Load a
profile by name with `load_endpoint(name)`.
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


@dataclass(frozen=True)
class GlobalConfig:
    anthropic_api_key: str
    model: str
    effort: str
    dry_run: bool


@dataclass(frozen=True)
class EndpointProfile:
    name: str
    url: str
    token: str
    prompt_file: Path
    journal_file: Path
    write_markers: tuple[str, ...] = ()
    max_writes_per_run: int | None = None
    notional_cap_usd: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def read_prompt(self) -> str:
        return self.prompt_file.read_text(encoding="utf-8")


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


def load_endpoint(name: str) -> EndpointProfile:
    registry = _load_registry()
    if name not in registry:
        available = ", ".join(sorted(registry.keys())) or "(none)"
        raise RuntimeError(
            f"Endpoint '{name}' not found in endpoints.yaml. Available: {available}"
        )
    raw = registry[name]

    url = raw.get("url")
    token_env = raw.get("token_env")
    prompt_file = raw.get("prompt_file")
    journal_file = raw.get("journal_file")
    if not (url and token_env and prompt_file and journal_file):
        raise RuntimeError(
            f"Endpoint '{name}' is missing one of: url, token_env, prompt_file, journal_file"
        )

    token = _require_env(token_env)

    markers = tuple(str(m).lower() for m in (raw.get("write_markers") or []))
    max_writes = raw.get("max_writes_per_run")
    notional_cap = raw.get("notional_cap_usd")

    prompt_path = (ROOT / prompt_file).resolve()
    journal_path = (ROOT / journal_file).resolve()

    return EndpointProfile(
        name=name,
        url=url,
        token=token,
        prompt_file=prompt_path,
        journal_file=journal_path,
        write_markers=markers,
        max_writes_per_run=int(max_writes) if max_writes is not None else None,
        notional_cap_usd=float(notional_cap) if notional_cap is not None else None,
        extra={k: v for k, v in raw.items()
               if k not in {"url", "token_env", "prompt_file", "journal_file",
                            "write_markers", "max_writes_per_run", "notional_cap_usd"}},
    )
