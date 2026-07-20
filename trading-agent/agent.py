"""Freeform LLM-driven trading agent connected to Robinhood via MCP.

Architecture:
    1. Open a local MCP session to Robinhood's Streamable HTTP server.
    2. Fetch its tool list and expose each tool to Claude directly (not via
       the mcp_servers connector) so we can intercept every tool call.
    3. Run a manual agent loop: on each `tool_use`, the safety gate decides
       whether to allow, block (dry-run / notional / count cap), or error.
       Allowed calls forward to the MCP session; blocked ones return a
       synthetic tool_result explaining the block so Claude can adapt.
    4. Every event lands in a JSONL journal. On the next run, the tail of
       the journal is rendered into the system prompt as recent history.

Usage:
    python agent.py "<instruction>"
    echo "<instruction>" | python agent.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

import anthropic

from config import Config, load_config
from journal import Journal, render_history
from mcp_client import open_session, render_tool_result, to_anthropic_tool
from safety import SafetyGate, is_write_tool


MAX_LOOP_ITERATIONS = 20


def _render_system(config: Config, journal: Journal) -> str:
    base = config.system_prompt.format(
        max_trades_per_run=config.max_trades_per_run,
        max_notional_per_trade_usd=int(config.max_notional_per_trade_usd),
    )
    history = render_history(journal.recent())
    if history:
        base += "\n\n## Recent history (from prior runs)\n\n" + history
    if config.dry_run:
        base += (
            "\n\n## Mode\n\nDRY_RUN is on. The harness will refuse any "
            "order-mutating tool call and return an error result. Describe "
            "each trade you would place instead."
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
    """Run one tool_use block through the safety gate and MCP session."""
    name: str = block.name
    args: dict[str, Any] = dict(block.input or {})

    print(
        f"  → {name} {json.dumps(args, default=str)[:400]}",
        file=sys.stderr,
        flush=True,
    )

    decision = gate.check(name, args)
    if not decision.allowed:
        journal.append(
            {"type": "tool_blocked", "tool": name, "args": args, "reason": decision.reason}
        )
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
        journal.append(
            {"type": "tool_error", "tool": name, "args": args, "error": str(exc)}
        )
        print(f"  ← ERROR: {exc}", file=sys.stderr, flush=True)
        return {
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": f"Tool execution error: {exc}",
            "is_error": True,
        }

    if is_write_tool(name):
        gate.record_allowed_write()

    text = render_tool_result(result)
    is_error = bool(getattr(result, "isError", False))
    journal.append(
        {
            "type": "tool_call",
            "tool": name,
            "args": args,
            "is_error": is_error,
            "result_summary": text[:800],
        }
    )
    tag = "ERR" if is_error else "ok"
    print(f"  ← {tag}: {text[:400]}", file=sys.stderr, flush=True)
    return {
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": text,
        "is_error": is_error,
    }


async def run(user_message: str, config: Config) -> None:
    journal = Journal(config.journal_path)
    gate = SafetyGate(config)
    mode = "DRY-RUN" if config.dry_run else "LIVE"

    journal.append(
        {"type": "run_start", "mode": mode, "model": config.model, "instruction": user_message}
    )
    print(f"[{mode}] model={config.model} effort={config.effort}", file=sys.stderr)

    client = anthropic.AsyncAnthropic(api_key=config.anthropic_api_key)
    final_text_parts: list[str] = []
    final_stop_reason: str | None = None

    async with open_session(config.robinhood_mcp_token) as session:
        tools_resp = await session.list_tools()
        anthropic_tools = [to_anthropic_tool(t) for t in tools_resp.tools]
        print(
            f"[mcp] connected — {len(anthropic_tools)} tools available",
            file=sys.stderr,
        )

        system = _render_system(config, journal)
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_message}]

        for _ in range(MAX_LOOP_ITERATIONS):
            response = await client.messages.create(
                model=config.model,
                max_tokens=16000,
                system=system,
                messages=messages,
                tools=anthropic_tools,
                thinking={"type": "adaptive"},
                output_config={"effort": config.effort},
            )
            _print_assistant(response.content)
            final_stop_reason = response.stop_reason
            for b in response.content:
                if getattr(b, "type", None) == "text" and b.text:
                    final_text_parts.append(b.text)

            if response.stop_reason == "refusal":
                details = getattr(response, "stop_details", None)
                journal.append(
                    {
                        "type": "refusal",
                        "category": getattr(details, "category", None),
                        "explanation": getattr(details, "explanation", None),
                    }
                )
                print(
                    f"\n[refused] category={getattr(details, 'category', None)}",
                    file=sys.stderr,
                )
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

    journal.append(
        {
            "type": "run_end",
            "mode": mode,
            "stop_reason": final_stop_reason,
            "writes_used": gate.writes_used,
            "final_text": "\n".join(final_text_parts)[-1200:],
        }
    )
    print(
        f"\n[done] stop={final_stop_reason} writes={gate.writes_used}/"
        f"{config.max_trades_per_run}",
        file=sys.stderr,
    )


def main() -> None:
    if len(sys.argv) > 1:
        instruction = " ".join(sys.argv[1:])
    else:
        instruction = sys.stdin.read()

    if not instruction.strip():
        print(
            "Provide an instruction. Example:\n"
            "  python agent.py 'Review my Agentic account and propose one trade.'",
            file=sys.stderr,
        )
        sys.exit(2)

    config = load_config()
    asyncio.run(run(instruction.strip(), config))


if __name__ == "__main__":
    main()
