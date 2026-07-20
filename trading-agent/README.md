# MCP-Connected Agent

A Python agent that drives Claude against any MCP endpoint declared in `endpoints.yaml`. Ships with a Robinhood Agentic Trading profile and a Linear example. Point it at a new endpoint by adding an entry to the YAML and a prompt file — no code changes.

The directory is still called `trading-agent/` because that's how the branch was created; it is no longer trading-specific.

## What it does

- Opens a local Streamable HTTP MCP session to the endpoint you pick.
- Lists that endpoint's tools and exposes them to Claude via the regular Messages API `tools=[...]` parameter (not the `mcp_servers` server-side connector — every tool call passes through this process).
- Runs an adaptive-thinking agent loop with a manual tool loop.
- Enforces per-endpoint safety rules in code (dry-run, write count cap, optional notional cap) before any mutating tool reaches the server. Refused calls come back to Claude as `is_error` results so it can adapt.
- Journals every event to a per-endpoint JSONL file; the tail is injected into the next run's system prompt so the agent has continuity across sessions.

## Prerequisites

1. Python ≥ 3.10.
2. An Anthropic API key.
3. For each MCP endpoint you want to use, an **OAuth bearer token**. Both Robinhood and Linear (and most other hosted MCPs) use OAuth 2.0; the fastest way to obtain a token today is to add the server in Claude Code (`npm i -g @anthropic-ai/claude-code`, then `claude mcp add <name> --transport http <url>`) and copy the stored bearer token out of `~/.claude/` into the corresponding env var.

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
# List available endpoints
python agent.py --list-endpoints

# Robinhood — DRY-RUN by default
python agent.py --endpoint robinhood "Review my Agentic account and propose one trade."

# Linear — describe actions in dry-run, act live when DRY_RUN=false
python agent.py --endpoint linear "Triage 'Backlog' issues assigned to me by priority."
```

Tool calls print to stderr; Claude's user-facing text goes to stdout; run detail lands in `journals/<endpoint>.jsonl`.

## Adding a new endpoint

1. **Register it in `endpoints.yaml`:**

    ```yaml
    endpoints:
      github:
        url: https://api.githubcopilot.com/mcp/
        token_env: GITHUB_MCP_TOKEN
        prompt_file: prompts/github.md
        journal_file: journals/github.jsonl
        write_markers: [create_, update_, delete_, merge_, close_]
        max_writes_per_run: 20
    ```

2. **Add the token env var** to your `.env`: `GITHUB_MCP_TOKEN=...`.
3. **Write `prompts/github.md`** with the agent's role, authority, and reporting style. See `prompts/robinhood.md` and `prompts/linear.md` for two shapes. Available placeholders: `{endpoint_name}`, `{max_writes_per_run}`, `{notional_cap_usd}` (renders as `"n/a"` when unset).
4. Run: `python agent.py --endpoint github "..."`.

### Per-endpoint fields

| Field | Required | Purpose |
| --- | --- | --- |
| `url` | ✅ | Streamable HTTP MCP endpoint. |
| `token_env` | ✅ * | Name of the env var holding the auth token. \* Optional if `auth_header: ''`. |
| `prompt_file` | ✅ | Path to the system prompt, relative to the package root. |
| `journal_file` | ✅ | Path to the JSONL journal. |
| `write_markers` | — | Substrings that mark a tool as a write. Empty/omitted = fully read-only endpoint (dry-run is inert). |
| `max_writes_per_run` | — | Cap on allowed writes per run. Omit for unlimited. |
| `notional_cap_usd` | — | Trading only. Requires `quantity` + `limit_price` on every write; refuses if `qty * price` exceeds the cap. |
| `auth_header` | — | HTTP header name for auth. Default `Authorization`. Set to `''` to disable auth entirely (public MCPs). |
| `auth_prefix` | — | Literal prefix in front of the token in the header. Default `Bearer `. |

Auth-scheme cheatsheet:

| Server pattern | `auth_header` | `auth_prefix` |
| --- | --- | --- |
| OAuth bearer (Robinhood, Linear) | *(default)* | *(default)* |
| Manifold-style `Key <token>` | *(default)* | `Key ` |
| `X-API-Key: <token>` | `X-API-Key` | `` (empty) |
| Unauthenticated | `''` | — |

Kalshi and other MCPs that use RSA-signed requests need **stdio transport**, not just a different header — this framework is Streamable-HTTP-only today. Adding stdio is a small change if you need it.

### Global env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required | Anthropic API key. |
| `DRY_RUN` | `true` | When `true`, all endpoints with a non-empty `write_markers` refuse mutations. |
| `MODEL` | `claude-opus-4-8` | Any Claude model that supports adaptive thinking. |
| `EFFORT` | `high` | `low` / `medium` / `high` / `xhigh` / `max`. |

## Safety notes

- The write-tool classifier is heuristic — a substring match against the tool name. On first connect the agent logs every discovered tool name to stderr; audit that list against your `write_markers` once per endpoint to make sure no destructive tool is misclassified as read.
- Enforcement is only as good as `write_markers`. If in doubt, err toward marking more things as writes.
- `notional_cap_usd` only applies to endpoints where a `quantity` + `limit_price` (or `price` / `estimated_price`) can be pulled from tool args. It is off unless set.
- `DRY_RUN=true` is the default. Flip it in `.env` (not on the command line) so a stray shell env doesn't accidentally arm live mode.
- Don't paste untrusted user input into the instruction. The agent runs with the full authority of whatever tokens are in `.env`.
- `.env` and `journals/` are gitignored. Rotate tokens by rewriting the env var and re-authenticating; never embed them in scripts.

## File layout

```
trading-agent/
├── agent.py              # entry — argparse + async tool loop
├── config.py             # GlobalConfig, EndpointProfile, YAML loader
├── mcp_client.py         # generic Streamable HTTP client
├── safety.py             # per-endpoint SafetyGate
├── journal.py            # JSONL journal + history renderer
├── endpoints.yaml        # endpoint registry
├── prompts/
│   ├── robinhood.md      # trading discipline
│   └── linear.md         # ops assistant (example)
└── journals/             # per-endpoint JSONL (gitignored)
```

## Extending

- **New domain** — add an endpoint block + prompt file. That's it.
- **Custom safety per endpoint** — extend `safety.SafetyGate.check` to read new fields from `EndpointProfile.extra` (any YAML keys not consumed by the built-in fields flow through into `extra`).
- **Scheduled runs** — invoke `python agent.py --endpoint <name> "..."` from cron. Start with `DRY_RUN=true` for several runs, read the journal, then arm.
- **Notifications** — wrap the agent invocation in a shell script that pipes the last journal entry to Slack / email when `writes_used > 0`.
