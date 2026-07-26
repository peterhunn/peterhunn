"""Generic MCP-driven agent. Point it at any MCP endpoint declared in
`endpoints.yaml` with `--endpoint <name>`; layer a named strategy from
`strategies.yaml` on top with `--strategy <name>`; the endpoint's profile
supplies the URL, auth env var, system prompt, journal path, and safety
rules; the strategy adds a prompt addendum and an optional default
instruction.

Usage:
    python agent.py --endpoint robinhood "Review my Agentic account."
    python agent.py --strategy dca-voo             # endpoint inferred, uses strategy's default instruction
    python agent.py --strategy triage-eng-p1 "Include stale P2s too."
    python agent.py --endpoint robinhood --propose-strategy   # LLM proposes strategies.yaml entries
    python agent.py --strategy dca-voo --reflect              # LLM critiques the strategy's history
    python agent.py --list-endpoints
    python agent.py --list-strategies

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

from config import (
    EndpointProfile,
    GlobalConfig,
    Strategy,
    list_endpoints,
    list_strategies,
    load_endpoint,
    load_global,
    load_strategy,
)
from journal import Journal, render_history
from mcp_client import open_session, render_tool_result, to_anthropic_tool
from pricing import cost_usd
from safety import SafetyGate, is_write_tool


MAX_LOOP_ITERATIONS = 20
ROOT = __import__("pathlib").Path(__file__).parent


def _render_system(
    profile: EndpointProfile,
    global_cfg: GlobalConfig,
    journal: Journal,
    strategy: Strategy | None = None,
    mode: str = "execute",
) -> str:
    """Compose the system prompt.

    mode="execute"  — endpoint prompt (+ optional strategy addendum)
    mode="propose"  — meta-prompt asking the model to propose new strategies
    mode="reflect"  — meta-prompt asking the model to critique one strategy
    """
    fmt_kwargs = {
        "endpoint_name": profile.name,
        "max_writes_per_run": profile.max_writes_per_run
        if profile.max_writes_per_run is not None
        else "unlimited",
        "notional_cap_usd": int(profile.notional_cap_usd)
        if profile.notional_cap_usd is not None
        else "n/a",
        "strategy_name": strategy.name if strategy else "",
    }

    if mode == "propose":
        template = (ROOT / "prompts" / "propose.md").read_text(encoding="utf-8")
    elif mode == "reflect":
        if strategy is None:
            raise RuntimeError("reflect mode requires --strategy")
        template = (ROOT / "prompts" / "reflect.md").read_text(encoding="utf-8")
    else:
        template = profile.read_prompt()

    try:
        base = template.format(**fmt_kwargs)
    except KeyError as e:
        raise RuntimeError(
            f"Prompt for mode '{mode}' references unknown placeholder "
            f"{{{e.args[0]}}}. Known: {sorted(fmt_kwargs)}"
        ) from e

    if mode == "execute" and strategy is not None:
        base += f"\n\n---\n\n{strategy.prompt_addendum.strip()}\n"

    # Filter history to the strategy being reflected on; otherwise show all.
    hist_filter = strategy.name if mode == "reflect" else None
    history = render_history(journal.recent(strategy=hist_filter))
    if history:
        header = (
            f"## Recent history for strategy `{strategy.name}`"
            if mode == "reflect"
            else "## Recent history (from prior runs)"
        )
        base += f"\n\n{header}\n\n{history}"

    if mode == "execute" and global_cfg.dry_run and profile.write_markers:
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
    user_message: str,
    profile: EndpointProfile,
    global_cfg: GlobalConfig,
    strategy: Strategy | None = None,
    mode: str = "execute",
) -> None:
    journal = Journal(profile.journal_file)
    # propose/reflect: read-only, dry-run forced regardless of env
    read_only = mode in ("propose", "reflect")
    effective_cfg = global_cfg
    if read_only and not global_cfg.dry_run:
        from dataclasses import replace
        effective_cfg = replace(global_cfg, dry_run=True)

    gate = SafetyGate(profile, effective_cfg, read_only=read_only)
    run_mode_tag = mode.upper() if mode != "execute" else (
        "DRY-RUN" if global_cfg.dry_run else "LIVE"
    )

    journal.append({
        "type": "run_start",
        "mode": run_mode_tag,
        "endpoint": profile.name,
        "strategy": strategy.name if strategy else None,
        "model": global_cfg.model,
        "instruction": user_message,
    })
    strategy_tag = f" strategy={strategy.name}" if strategy else ""
    print(
        f"[{run_mode_tag}] endpoint={profile.name}{strategy_tag} "
        f"model={global_cfg.model} effort={global_cfg.effort}",
        file=sys.stderr,
    )

    client = anthropic.AsyncAnthropic(api_key=global_cfg.anthropic_api_key)
    final_text_parts: list[str] = []
    final_stop_reason: str | None = None
    usage_totals: dict[str, int] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }

    async with open_session(profile) as session:
        tools_resp = await session.list_tools()
        anthropic_tools = [to_anthropic_tool(t) for t in tools_resp.tools]
        print(
            f"[mcp] connected via {profile.location()} — {len(anthropic_tools)} tools",
            file=sys.stderr,
        )

        system = _render_system(profile, effective_cfg, journal, strategy, mode)
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
            u = response.usage
            for k in usage_totals:
                usage_totals[k] += getattr(u, k, 0) or 0

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

    run_cost_usd = cost_usd(global_cfg.model, usage_totals)
    journal.append({
        "type": "run_end",
        "mode": run_mode_tag,
        "endpoint": profile.name,
        "strategy": strategy.name if strategy else None,
        "stop_reason": final_stop_reason,
        "writes_used": gate.writes_used,
        "usage": usage_totals,
        "cost_usd": round(run_cost_usd, 4),
        "final_text": "\n".join(final_text_parts)[-1200:],
    })
    cost_str = f"cost=${run_cost_usd:.4f}"
    if read_only:
        print(f"\n[done] stop={final_stop_reason} (read-only) {cost_str}", file=sys.stderr)
    else:
        cap = profile.max_writes_per_run
        cap_str = str(cap) if cap is not None else "∞"
        print(
            f"\n[done] stop={final_stop_reason} writes={gate.writes_used}/{cap_str} {cost_str}",
            file=sys.stderr,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="MCP-connected agent.")
    parser.add_argument(
        "--endpoint",
        "-e",
        help="Name of an endpoint from endpoints.yaml. Inferred from "
        "--strategy if that is given instead.",
    )
    parser.add_argument(
        "--strategy",
        "-s",
        help="Name of a strategy from strategies.yaml.",
    )
    parser.add_argument(
        "--list-endpoints",
        action="store_true",
        help="List available endpoints and exit.",
    )
    parser.add_argument(
        "--list-strategies",
        action="store_true",
        help="List available strategies and exit.",
    )
    parser.add_argument(
        "--propose-strategy",
        action="store_true",
        help="Meta-mode: use MCP read tools to research the endpoint and "
        "output proposed strategies.yaml entries. Read-only; forces dry-run. "
        "Requires --endpoint.",
    )
    parser.add_argument(
        "--reflect",
        action="store_true",
        help="Meta-mode: review a strategy's journal history and propose one "
        "concrete edit to its prompt_addendum. Read-only; forces dry-run. "
        "Requires --strategy.",
    )
    parser.add_argument(
        "--design-strategy",
        nargs="?",
        const="",
        metavar="NAME",
        help="Open the interactive terminal designer to author or edit a "
        "strategy in natural language. Optional NAME pre-fills or edits an "
        "existing strategy of that name. Pair with --endpoint to pre-bind "
        "the target endpoint.",
    )
    parser.add_argument(
        "--web",
        action="store_true",
        help="Launch the browser-based strategy designer (two-pane UI: "
        "chat + live-editable YAML). Binds to 127.0.0.1.",
    )
    parser.add_argument(
        "--web-port",
        type=int,
        default=8765,
        help="Port for --web (default 8765).",
    )
    parser.add_argument(
        "--web-no-browser",
        action="store_true",
        help="With --web, do not auto-open the browser.",
    )
    parser.add_argument(
        "instruction",
        nargs="*",
        help="Instruction to send to the agent. If omitted and --strategy "
        "supplies an initial_instruction, that is used. Otherwise, read "
        "from stdin.",
    )
    args = parser.parse_args()

    if args.list_endpoints:
        for name in list_endpoints():
            print(name)
        return
    if args.list_strategies:
        for name in list_strategies():
            print(name)
        return

    if args.web:
        from web import run as run_web
        run_web(port=args.web_port, open_browser=not args.web_no_browser)
        return

    if args.design_strategy is not None:
        from designer import run_designer
        name_hint = args.design_strategy or None
        run_designer(args.endpoint, name_hint)
        return

    if args.propose_strategy and args.reflect:
        parser.error("--propose-strategy and --reflect are mutually exclusive")

    mode = "execute"
    if args.propose_strategy:
        mode = "propose"
    elif args.reflect:
        mode = "reflect"

    strategy: Strategy | None = None
    if args.strategy:
        strategy = load_strategy(args.strategy)
        if args.endpoint and args.endpoint != strategy.endpoint:
            parser.error(
                f"--strategy {args.strategy} binds to endpoint "
                f"'{strategy.endpoint}', but --endpoint '{args.endpoint}' "
                "was passed. Drop --endpoint or pass a matching one."
            )
        endpoint_name = strategy.endpoint
    elif args.endpoint:
        endpoint_name = args.endpoint
    else:
        parser.error("pass --endpoint or --strategy (or --list-* to inspect)")

    if mode == "propose" and not args.endpoint and args.strategy:
        parser.error(
            "--propose-strategy operates on an endpoint, not a strategy. "
            "Use --endpoint <name>."
        )
    if mode == "reflect" and strategy is None:
        parser.error("--reflect requires --strategy <name>")

    cli_instruction = " ".join(args.instruction).strip()
    if cli_instruction:
        instruction = cli_instruction
    elif mode == "propose":
        instruction = (
            "Research the current state of this endpoint and propose 1–3 "
            "strategies I could formalize. End with a YAML block."
        )
    elif mode == "reflect":
        instruction = (
            f"Review recent runs of strategy '{strategy.name}' and propose "
            "one concrete edit to its prompt_addendum. End with a YAML block."
        )
    elif strategy and strategy.initial_instruction:
        instruction = strategy.initial_instruction
    else:
        instruction = sys.stdin.read().strip()

    if not instruction:
        parser.error(
            "provide an instruction as arguments or on stdin, e.g.:\n"
            "  python agent.py --endpoint robinhood 'Review my account.'"
        )

    global_cfg = load_global()
    profile = load_endpoint(endpoint_name)
    asyncio.run(run(instruction, profile, global_cfg, strategy, mode))


if __name__ == "__main__":
    main()
