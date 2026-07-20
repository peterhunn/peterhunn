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

Two layers now:

- **Hard boundary (Robinhood-side):** the MCP restricts order placement to your dedicated Agentic account. Your main brokerage cannot be traded regardless of what happens on this side. Fund the Agentic account with what you are prepared to lose.
- **Code-enforced boundary (this harness):** `DRY_RUN`, `MAX_TRADES_PER_RUN`, and `MAX_NOTIONAL_PER_TRADE_USD` are now enforced by `safety.py`, which sits between Claude and the MCP server. Violations return a `BLOCKED by harness` error and never touch Robinhood. This makes the limits real, not aspirational.

The write-tool classifier is heuristic — it matches common name patterns like `place_*`, `submit_*`, `cancel_*`, `modify_*`, `buy*`, `sell*`. If Robinhood ships a mutating tool with a different name convention, `safety.WRITE_TOOL_MARKERS` may need an update. When you first connect, the stderr log lists every discovered tool — audit that list once.

Other precautions:
- Do not paste untrusted user input into the instruction. Anything you send becomes autonomous authority.
- Never commit `.env` or `journal.jsonl` (both are gitignored). The journal may include position sizes and other account-level detail.
- If you rotate or revoke the OAuth token, replace `ROBINHOOD_MCP_TOKEN` and re-run the Claude Code `mcp add` flow — do not embed tokens in scripts.

## How it works (implementation)

- **Local MCP client.** `mcp_client.py` opens a Streamable HTTP session to `agent.robinhood.com/mcp/trading` using the `mcp` Python package, listing Robinhood's tools at start-up and forwarding calls one at a time. No `mcp_servers` connector — every tool call passes through our process, which is what makes real enforcement possible.
- **Manual tool loop.** `agent.py` runs an async `messages.create → tool_use → tool_result` loop with adaptive thinking and configurable effort. Robinhood's MCP tools are passed to Claude as regular `tools=[...]`.
- **Safety gate (`safety.py`).** Every tool call is classified read vs. write by name pattern (`place_*`, `submit_*`, `cancel_*`, `modify_*`, `buy*`, `sell*`, etc.). Writes are refused when `DRY_RUN=true`, when the per-run write count is at `MAX_TRADES_PER_RUN`, or when computed notional (`qty * limit_price`) exceeds `MAX_NOTIONAL_PER_TRADE_USD`. Market orders that don't include price info are refused — supply a `limit_price`. Refusals return a synthetic `tool_result` with `is_error: true` so Claude can adapt.
- **Journal (`journal.py`).** Every run appends to `journal.jsonl`: run boundaries, each tool call and its result summary, blocks, errors, refusals, and the final assistant text. On next start-up, the last ~60 entries are rendered into the system prompt as a "Recent history" block, so the agent has continuity across runs.

### File layout

```
trading-agent/
├── agent.py          # entry — async tool loop
├── config.py         # env → typed Config
├── mcp_client.py     # Streamable HTTP client + result rendering
├── safety.py         # write-tool classifier + notional/count gate
├── journal.py        # JSONL journal + history renderer
└── prompts/system.md # the trading discipline prompt
```

## Extending

- Add a **watchlist-only mode** by narrowing the system prompt.
- Swap the freeform instruction for a **rule-based auto-trader** by adding a config file describing rules and having the agent execute them mechanically.
- Wire this into cron for scheduled runs, but start with `DRY_RUN=true` and read the logs for several sessions first.
