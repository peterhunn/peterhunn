"""Freeform LLM-driven trading agent connected to Robinhood via MCP.

Usage:
    uv run python agent.py "<instruction for the agent>"
    uv run python agent.py            # reads from stdin

Safety:
    - DRY_RUN=true (default) tells the agent to describe trades, not place them.
      This is prompt-level; the LLM must obey. The definitive safety measure
      is funding the Robinhood Agentic account with only what you can lose.
    - MAX_NOTIONAL_PER_TRADE_USD and MAX_TRADES_PER_RUN are also prompt-level.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import anthropic

from config import ROBINHOOD_MCP_URL, Config, load_config


MAX_LOOP_ITERATIONS = 15


def _mcp_server(config: Config) -> dict[str, Any]:
    return {
        "type": "url",
        "name": "robinhood",
        "url": ROBINHOOD_MCP_URL,
        "authorization_token": config.robinhood_mcp_token,
    }


def _render_system(config: Config) -> str:
    return config.system_prompt.format(
        max_trades_per_run=config.max_trades_per_run,
        max_notional_per_trade_usd=int(config.max_notional_per_trade_usd),
    )


def _dry_run_banner() -> str:
    return (
        "DRY_RUN is ON for this run. Do NOT invoke any order-placement tool. "
        "Read data as much as you need, then describe each trade you would "
        "place as if you were calling the tool, including exact arguments. "
        "End with the trade log."
    )


def _print_text_blocks(content: list[Any]) -> None:
    for block in content:
        if getattr(block, "type", None) == "text" and block.text:
            print(block.text, flush=True)


def _print_tool_activity(content: list[Any]) -> None:
    for block in content:
        btype = getattr(block, "type", None)
        if btype == "mcp_tool_use":
            args = getattr(block, "input", {})
            print(
                f"  → tool call: {block.name} {json.dumps(args, default=str)[:400]}",
                file=sys.stderr,
                flush=True,
            )
        elif btype == "mcp_tool_result":
            is_error = getattr(block, "is_error", False)
            preview = json.dumps(getattr(block, "content", ""), default=str)[:400]
            tag = "ERROR" if is_error else "ok"
            print(f"  ← tool result [{tag}]: {preview}", file=sys.stderr, flush=True)


def _log_run(config: Config, response: Any) -> None:
    runs_dir = Path(__file__).parent / "runs"
    runs_dir.mkdir(exist_ok=True)
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    path = runs_dir / f"{ts}-{'dry' if config.dry_run else 'live'}.json"
    try:
        path.write_text(response.model_dump_json(indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"(could not write run log: {exc})", file=sys.stderr)


def run(user_message: str, config: Config) -> None:
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)

    system = _render_system(config)
    if config.dry_run:
        system = f"{system}\n\n{_dry_run_banner()}"

    messages: list[dict[str, Any]] = [
        {"role": "user", "content": user_message.strip()}
    ]

    mode = "DRY-RUN" if config.dry_run else "LIVE"
    print(f"[{mode}] model={config.model} effort={config.effort}", file=sys.stderr)

    final_response = None
    for _ in range(MAX_LOOP_ITERATIONS):
        response = client.beta.messages.create(
            model=config.model,
            max_tokens=16000,
            system=system,
            messages=messages,
            thinking={"type": "adaptive"},
            output_config={"effort": config.effort},
            mcp_servers=[_mcp_server(config)],
            tools=[{"type": "mcp_toolset", "mcp_server_name": "robinhood"}],
            betas=["mcp-client-2025-11-20"],
        )
        final_response = response

        _print_tool_activity(response.content)
        _print_text_blocks(response.content)

        if response.stop_reason == "pause_turn":
            messages.append({"role": "assistant", "content": response.content})
            continue

        if response.stop_reason == "refusal":
            details = getattr(response, "stop_details", None)
            print(
                f"\n[refused] category={getattr(details, 'category', None)} "
                f"explanation={getattr(details, 'explanation', None)}",
                file=sys.stderr,
            )
            break

        break

    if final_response is not None:
        usage = final_response.usage
        print(
            f"\n[usage] input={usage.input_tokens} output={usage.output_tokens} "
            f"cache_read={getattr(usage, 'cache_read_input_tokens', 0)} "
            f"stop={final_response.stop_reason}",
            file=sys.stderr,
        )
        _log_run(config, final_response)


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
    run(instruction, config)


if __name__ == "__main__":
    main()
