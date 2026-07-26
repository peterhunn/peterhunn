"""Interactive strategy designer.

Claude interviews the operator in natural language and emits YAML for
strategies.yaml. The operator refines by talking back; slash commands
drive save/edit/quit. Nothing is auto-applied — /save appends to
strategies.yaml and immediately opens $EDITOR positioned on the file so
the operator can polish or revert the change.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import anthropic
import yaml

from config import GlobalConfig, list_endpoints, load_endpoint, load_global

ROOT = Path(__file__).parent
STRATEGIES_YAML = ROOT / "strategies.yaml"
DESIGN_PROMPT_PATH = ROOT / "prompts" / "design.md"
YAML_BLOCK_RE = re.compile(r"```yaml\s*\n(.*?)\n```", re.DOTALL)

BANNER = """\
strategy designer — describe what you want in plain english.
Commands:
  /save     append the current draft to strategies.yaml, then open $EDITOR
  /edit     open strategies.yaml in $EDITOR now (no save)
  /show     print the current YAML draft
  /quit     exit without saving
"""


def _extract_yaml(text: str) -> str | None:
    """Return the last fenced ```yaml block from `text`, or None."""
    matches = YAML_BLOCK_RE.findall(text or "")
    return matches[-1].strip() if matches else None


def _load_current_strategies() -> dict[str, Any]:
    if not STRATEGIES_YAML.exists():
        return {"strategies": {}}
    doc = yaml.safe_load(STRATEGIES_YAML.read_text(encoding="utf-8")) or {}
    doc.setdefault("strategies", {})
    if not isinstance(doc.get("strategies"), dict):
        raise RuntimeError("strategies.yaml is malformed — top-level `strategies:` must be a mapping")
    return doc


def _merge_yaml_block(yaml_block: str) -> tuple[list[str], list[str]]:
    """Merge the YAML block into strategies.yaml. Returns (added, replaced)."""
    incoming = yaml.safe_load(yaml_block) or {}
    if not isinstance(incoming, dict) or "strategies" not in incoming:
        raise RuntimeError("YAML block must define a top-level `strategies:` mapping")
    if not isinstance(incoming["strategies"], dict):
        raise RuntimeError("`strategies:` must be a mapping of name → config")

    current = _load_current_strategies()
    added: list[str] = []
    replaced: list[str] = []
    for name, spec in incoming["strategies"].items():
        if name in current["strategies"]:
            replaced.append(name)
        else:
            added.append(name)
        current["strategies"][name] = spec

    STRATEGIES_YAML.write_text(
        yaml.safe_dump(current, sort_keys=False, default_flow_style=False, width=100),
        encoding="utf-8",
    )
    return added, replaced


def _open_editor(path: Path) -> int:
    editor = os.environ.get("EDITOR") or os.environ.get("VISUAL")
    if not editor:
        for candidate in ("nano", "vim", "vi", "code"):
            if shutil.which(candidate):
                editor = candidate
                break
    if not editor:
        print(f"no $EDITOR set and no fallback found. file at: {path}", file=sys.stderr)
        return 1
    return subprocess.run([editor, str(path)]).returncode


async def _turn(
    client: anthropic.AsyncAnthropic,
    system: str,
    messages: list[dict[str, Any]],
    model: str,
) -> str:
    response = await client.messages.create(
        model=model,
        max_tokens=8000,
        system=system,
        messages=messages,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},
    )
    return "".join(
        block.text for block in response.content
        if getattr(block, "type", None) == "text" and block.text
    )


async def _run_designer(global_cfg: GlobalConfig, seed_context: str) -> None:
    system = DESIGN_PROMPT_PATH.read_text(encoding="utf-8")
    client = anthropic.AsyncAnthropic(api_key=global_cfg.anthropic_api_key)
    messages: list[dict[str, Any]] = []
    last_yaml: str | None = None

    print(BANNER, flush=True)

    if seed_context:
        print(f"(context)\n{seed_context}\n", flush=True)
        messages.append({"role": "user", "content": seed_context})
        reply = await _turn(client, system, messages, global_cfg.model)
        messages.append({"role": "assistant", "content": reply})
        print(f"claude: {reply}\n", flush=True)
        maybe = _extract_yaml(reply)
        if maybe:
            last_yaml = maybe

    while True:
        try:
            user_line = input("you: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n(bye)")
            return
        if not user_line:
            continue

        if user_line in ("/quit", "/q", "/exit"):
            print("(bye)")
            return
        if user_line == "/show":
            if last_yaml:
                print("\n--- current draft ---\n" + last_yaml + "\n---\n", flush=True)
            else:
                print("no YAML draft yet — keep chatting.", flush=True)
            continue
        if user_line == "/edit":
            _open_editor(STRATEGIES_YAML)
            continue
        if user_line == "/save":
            if not last_yaml:
                print("no YAML draft to save — keep chatting.", flush=True)
                continue
            try:
                added, replaced = _merge_yaml_block(last_yaml)
            except Exception as e:
                print(f"save failed: {e}", flush=True)
                continue
            parts = []
            if added:
                parts.append(f"added: {', '.join(added)}")
            if replaced:
                parts.append(f"replaced: {', '.join(replaced)}")
            print(
                f"saved to {STRATEGIES_YAML} ({'; '.join(parts) or 'no change'}).",
                flush=True,
            )
            print("opening in $EDITOR — edit or revert as needed.", flush=True)
            _open_editor(STRATEGIES_YAML)
            print("(designer exit after save)", flush=True)
            return

        # Normal conversational turn
        messages.append({"role": "user", "content": user_line})
        try:
            reply = await _turn(client, system, messages, global_cfg.model)
        except Exception as e:
            print(f"error: {e}", flush=True)
            messages.pop()
            continue
        messages.append({"role": "assistant", "content": reply})
        print(f"\nclaude: {reply}\n", flush=True)
        maybe = _extract_yaml(reply)
        if maybe:
            last_yaml = maybe


def run_designer(endpoint_hint: str | None, name_hint: str | None) -> None:
    if not sys.stdin.isatty():
        print("--design-strategy requires an interactive terminal.", file=sys.stderr)
        sys.exit(2)

    global_cfg = load_global()

    seed_bits: list[str] = []
    if endpoint_hint:
        try:
            load_endpoint(endpoint_hint)
        except Exception as e:
            print(f"unknown endpoint '{endpoint_hint}': {e}", file=sys.stderr)
            sys.exit(2)
        seed_bits.append(f"Target endpoint: {endpoint_hint}")
    else:
        seed_bits.append(f"Available endpoints: {', '.join(list_endpoints())}")

    if name_hint:
        current = _load_current_strategies()["strategies"]
        if name_hint in current:
            existing = yaml.safe_dump(
                {"strategies": {name_hint: current[name_hint]}},
                sort_keys=False,
                default_flow_style=False,
                width=100,
            )
            seed_bits.append(
                f"Editing existing strategy '{name_hint}'. Current YAML:\n\n{existing}"
            )
        else:
            seed_bits.append(f"Creating a new strategy named '{name_hint}'.")

    asyncio.run(_run_designer(global_cfg, "\n\n".join(seed_bits)))
