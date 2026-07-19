# Robinhood Agentic Trading Agent

A standalone Python agent that connects Claude (via the Anthropic MCP connector) to Robinhood's Agentic Trading MCP server at `https://agent.robinhood.com/mcp/trading`. Claude reads your accounts, quotes, and orders; if `DRY_RUN=false`, it can place equity orders in your dedicated Robinhood Agentic account.

## What this does — and does not

- ✅ Connects to Robinhood's MCP directly from a Python process using the Anthropic Messages API's `mcp_servers` parameter (no local MCP daemon required).
- ✅ Gives Claude an autonomous, freeform mandate to review your positions and propose/execute trades.
- ✅ Logs every tool call and every full response to `runs/`.
- ⚠️ Trades **real money** in your Robinhood Agentic account when `DRY_RUN=false`. Read the safety section before flipping that.
- ⚠️ Equities only — Robinhood's MCP is equities-only in beta.

## Prerequisites

1. A Robinhood account with an **Agentic account** opened, funded, and an AI agent authorized. Follow Robinhood's onboarding on a desktop browser: <https://robinhood.com/us/en/support/articles/agentic-trading-overview/>.
2. Python ≥ 3.10.
3. An Anthropic API key.
4. An **OAuth bearer token** for the Robinhood MCP server. Robinhood's MCP uses OAuth 2.0; the easiest way to obtain one today is:
   - Install Claude Code (`npm i -g @anthropic-ai/claude-code`).
   - Run `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading` and complete the browser flow it prints.
   - Find the stored bearer token in your Claude Code config (typically under `~/.claude/` — inspect the config file for a `robinhood-trading` entry with an `Authorization: Bearer <token>` header).
   - Copy the token into `ROBINHOOD_MCP_TOKEN`. Tokens expire; re-authenticate the same way when they do.

## Install

```bash
cd trading-agent
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env
$EDITOR .env
```

## Run

```bash
# DRY-RUN (default): Claude reads data and describes trades but does not place them.
python agent.py "Review my Agentic account and propose one trade with rationale."

# LIVE: set DRY_RUN=false in .env, then:
python agent.py "Execute one small position in a large-cap tech name of your choosing."
```

Tool calls are streamed to stderr; Claude's user-facing text goes to stdout. Full responses land in `runs/`.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required | Your Anthropic API key. |
| `ROBINHOOD_MCP_TOKEN` | required | OAuth bearer token for `agent.robinhood.com/mcp/trading`. |
| `DRY_RUN` | `true` | If `true`, Claude describes trades but is instructed not to place them. |
| `MAX_TRADES_PER_RUN` | `3` | Prompt-level trade count cap. |
| `MAX_NOTIONAL_PER_TRADE_USD` | `250` | Prompt-level per-order dollar cap. |
| `MODEL` | `claude-opus-4-8` | Any Claude model that supports MCP + adaptive thinking. |
| `EFFORT` | `high` | `low` / `medium` / `high` / `xhigh` / `max`. |

## Safety — read this before setting `DRY_RUN=false`

- The **only hard safety measure** is how you fund the Agentic account. Fund it with what you are prepared to lose. Robinhood's MCP restricts order placement to that account (your main brokerage account is read-only), which is the actual security boundary.
- `DRY_RUN`, `MAX_TRADES_PER_RUN`, and `MAX_NOTIONAL_PER_TRADE_USD` are **prompt-level** limits. They are enforced by Claude following the system prompt, not by intercepting tool calls (the MCP connector runs tools server-side; there is no local interception point). A well-aligned model will respect them; a jailbroken conversation or a bug in the prompt could exceed them.
- Do not paste untrusted user input into the instruction. Anything you send becomes autonomous authority. Prefer running with a fixed instruction from a config or hard-coded string.
- Never commit `.env` or `runs/` (both are gitignored). Run logs may include position sizes and other account-level detail.
- If you rotate or revoke the OAuth token, replace `ROBINHOOD_MCP_TOKEN` and re-run the Claude Code `mcp add` flow — do not embed tokens in scripts.

## How it works (implementation)

- Uses `client.beta.messages.create(...)` with `mcp_servers=[{...robinhood...}]` and `tools=[{"type": "mcp_toolset", "mcp_server_name": "robinhood"}]`, plus beta header `mcp-client-2025-11-20`. Anthropic's platform makes the MCP call to Robinhood on your behalf and inlines `mcp_tool_use` / `mcp_tool_result` blocks in the response.
- Adaptive thinking (`thinking={"type": "adaptive"}`) with configurable `effort`.
- Loops on `stop_reason == "pause_turn"` (server-side iteration cap), which the MCP connector may return on long trading sessions; capped at 15 iterations to bound spend.
- Refusals surface as a stderr line and end the run.

## Extending

- Add a **watchlist-only mode** by narrowing the system prompt.
- Swap the freeform instruction for a **rule-based auto-trader** by adding a config file describing rules and having the agent execute them mechanically.
- Wire this into cron for scheduled runs, but start with `DRY_RUN=true` and read the logs for several sessions first.
