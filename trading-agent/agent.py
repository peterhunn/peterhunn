"""Generic MCP-driven agent. Point it at any MCP endpoint declared in
`endpoints.yaml` with `--endpoint <name>`; the endpoint's profile supplies
the URL, auth env var, system prompt, journal path, and safety rules.

Usage:
    python agent.py --endpoint robinhood "Review my Agentic account."
    python agent.py --endpoint linear "Triage Backlog issues assigned to me."
    python agent.py --list-endpoints

Behavior:
    - Opens a local Streamable HTTP MCP session for the chosen endpoint.
    - Lists that endpoint's tools and exposes them to Claude as regular tools.
    - Runs a manual tool_use loop with adaptive thinking.
    - Each tool call passes through SafetyGate first: writes (identified by
      the endpoint's write_markers) are refused if DRY_RUN is on, if the
      per-run cap is hit, or (trading only) if computed notional exceeds
      notional_cap_usd. Refusals return an is_error tool_result.
    - Every event lands in the endpoint's JSONL journal, and the tail is
      injected as "Recent history" into the next run's system prompt.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

import anthropic

from config import EndpointProfile, GlobalConfig, list_endpoints, load_endpoint, load_global
from journal import Journal, render_history
from mcp_client import open_session, render_tool_result, to_anthropic_tool
from safety import SafetyGate, is_write_tool


MAX_LOOP_ITERATIONS = 20


def _render_system(
    profile: EndpointProfile, global_cfg: GlobalConfig, journal: Journal
) -> str:
    base_template = profile.read_prompt()
    fmt_kwargs = {
        "endpoint_name": profile.name,
        "max_writes_per_run": profile.max_writes_per_run
        if profile.max_writes_per_run is not None
        else "unlimited",
        "notional_cap_usd": int(profile.notional_cap_usd)
        if profile.notional_cap_usd is not None
        else "n/a",
    }
    try:
        base = base_template.format(**fmt_kwargs)
    except KeyError as e:
        raise RuntimeError(
            f"Prompt for endpoint '{profile.name}' references unknown "
            f"placeholder {{{e.args[0]}}}. Known: {sorted(fmt_kwargs)}"
        ) from e

    history = render_history(journal.recent())
    if history:
        base += "\n\n## Recent history (from prior runs)\n\n" + history

    if global_cfg.dry_run and profile.write_markers:
        base += (
            "\n\n## Mode\n\nDRY_RUN is on. The harness will refuse any write "
            "tool call and return an error result. Describe each action you "
            "would take instead."
        )
    return base


def _print_assistant(content: list[Any]) -> None:
    for block in content:
        if getattr(block, "type", None) == "text" and block.text:
            print(block.text, flush=True)


async def _handle_tool_call(
    block: Any,
    session: Any,
    gate: SafetyGate,
    journal: Journal,
) -> dict[str, Any]:
    name: str = block.name
    args: dict[str, Any] = dict(block.input or {})

    print(f"  → {name} {json.dumps(args, default=str)[:400]}", file=sys.stderr, flush=True)

    decision = gate.check(name, args)
    if not decision.allowed:
        journal.append({"type": "tool_blocked", "tool": name, "args": args, "reason": decision.reason})
        print(f"  ← BLOCKED: {decision.reason}", file=sys.stderr, flush=True)
        return {
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": f"BLOCKED by harness: {decision.reason}",
            "is_error": True,
        }

    try:
        result = await session.call_tool(name, args)
    except Exception as exc:
        journal.append({"type": "tool_error", "tool": name, "args": args, "error": str(exc)})
        print(f"  ← ERROR: {exc}", file=sys.stderr, flush=True)
        return {
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": f"Tool execution error: {exc}",
            "is_error": True,
        }

    if is_write_tool(name, gate.profile.write_markers):
        gate.record_allowed_write()

    text = render_tool_result(result)
    is_error = bool(getattr(result, "isError", False))
    journal.append({
        "type": "tool_call",
        "tool": name,
        "args": args,
        "is_error": is_error,
        "result_summary": text[:800],
    })
    tag = "ERR" if is_error else "ok"
    print(f"  ← {tag}: {text[:400]}", file=sys.stderr, flush=True)
    return {
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": text,
        "is_error": is_error,
    }


async def run(
    user_message: str, profile: EndpointProfile, global_cfg: GlobalConfig
) -> None:
    journal = Journal(profile.journal_file)
    gate = SafetyGate(profile, global_cfg)
    mode = "DRY-RUN" if global_cfg.dry_run else "LIVE"

    journal.append({
        "type": "run_start",
        "mode": mode,
        "endpoint": profile.name,
        "model": global_cfg.model,
        "instruction": user_message,
    })
    print(
        f"[{mode}] endpoint={profile.name} model={global_cfg.model} "
        f"effort={global_cfg.effort}",
        file=sys.stderr,
    )

    client = anthropic.AsyncAnthropic(api_key=global_cfg.anthropic_api_key)
    final_text_parts: list[str] = []
    final_stop_reason: str | None = None

    async with open_session(profile.url, profile.token) as session:
        tools_resp = await session.list_tools()
        anthropic_tools = [to_anthropic_tool(t) for t in tools_resp.tools]
        print(
            f"[mcp] connected to {profile.url} — {len(anthropic_tools)} tools",
            file=sys.stderr,
        )

        system = _render_system(profile, global_cfg, journal)
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_message}]

        for _ in range(MAX_LOOP_ITERATIONS):
            response = await client.messages.create(
                model=global_cfg.model,
                max_tokens=16000,
                system=system,
                messages=messages,
                tools=anthropic_tools,
                thinking={"type": "adaptive"},
                output_config={"effort": global_cfg.effort},
            )
            _print_assistant(response.content)
            final_stop_reason = response.stop_reason
            for b in response.content:
                if getattr(b, "type", None) == "text" and b.text:
                    final_text_parts.append(b.text)

            if response.stop_reason == "refusal":
                details = getattr(response, "stop_details", None)
                journal.append({
                    "type": "refusal",
                    "category": getattr(details, "category", None),
                    "explanation": getattr(details, "explanation", None),
                })
                print(f"\n[refused] category={getattr(details, 'category', None)}", file=sys.stderr)
                break

            if response.stop_reason == "end_turn":
                break

            if response.stop_reason == "tool_use":
                messages.append({"role": "assistant", "content": response.content})
                tool_results: list[dict[str, Any]] = []
                for block in response.content:
                    if getattr(block, "type", None) != "tool_use":
                        continue
                    tool_results.append(
                        await _handle_tool_call(block, session, gate, journal)
                    )
                messages.append({"role": "user", "content": tool_results})
                continue

            if response.stop_reason == "pause_turn":
                messages.append({"role": "assistant", "content": response.content})
                continue

            break

    journal.append({
        "type": "run_end",
        "mode": mode,
        "endpoint": profile.name,
        "stop_reason": final_stop_reason,
        "writes_used": gate.writes_used,
        "final_text": "\n".join(final_text_parts)[-1200:],
    })
    cap = profile.max_writes_per_run
    cap_str = str(cap) if cap is not None else "∞"
    print(
        f"\n[done] stop={final_stop_reason} writes={gate.writes_used}/{cap_str}",
        file=sys.stderr,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="MCP-connected agent.")
    parser.add_argument(
        "--endpoint",
        "-e",
        help="Name of an endpoint from endpoints.yaml.",
    )
    parser.add_argument(
        "--list-endpoints",
        action="store_true",
        help="List available endpoints and exit.",
    )
    parser.add_argument(
        "instruction",
        nargs="*",
        help="Instruction to send to the agent. If omitted, read from stdin.",
    )
    args = parser.parse_args()

    if args.list_endpoints:
        for name in list_endpoints():
            print(name)
        return

    if not args.endpoint:
        parser.error("--endpoint is required (or pass --list-endpoints)")

    instruction = " ".join(args.instruction).strip() or sys.stdin.read().strip()
    if not instruction:
        parser.error(
            "provide an instruction as arguments or on stdin, e.g.:\n"
            "  python agent.py --endpoint robinhood 'Review my account.'"
        )

    global_cfg = load_global()
    profile = load_endpoint(args.endpoint)
    asyncio.run(run(instruction, profile, global_cfg))


if __name__ == "__main__":
    main()
