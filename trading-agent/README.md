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
# List what's available
python agent.py --list-endpoints
python agent.py --list-strategies

# Freeform on an endpoint (DRY-RUN by default)
python agent.py --endpoint robinhood "Review my Agentic account and propose one trade."

# Named strategy — endpoint is inferred; instruction defaults to the
# strategy's initial_instruction
python agent.py --strategy dca-voo

# Named strategy with an ad-hoc instruction override
python agent.py --strategy triage-eng-p1 "Also include P2 issues older than 30 days."
```

Tool calls print to stderr; Claude's user-facing text goes to stdout; run detail lands in `journals/<endpoint>.jsonl`.

## Strategies

Strategies live in `strategies.yaml`. Each entry binds to one endpoint and layers a prompt addendum on top of that endpoint's base system prompt — a way to keep several tightly-scoped agents (DCA into VOO, weekly issue triage, morning market scan) alongside the general-purpose freeform agent.

```yaml
strategies:
  dca-voo:
    endpoint: robinhood
    prompt_addendum: |
      ## Strategy: Weekly DCA into VOO
      - Only buy VOO. Refuse any other trade this run.
      - Read journal; if a VOO buy in the last 6 days, skip.
      - Limit at current ask, $50 notional.
    initial_instruction: "Execute this week's DCA into VOO if not already done."
```

**How strategies compose with everything else:**
- Endpoint choice: inferred from the strategy. If you also pass `--endpoint`, it must match — mismatch is a hard error.
- Instruction: positional CLI arg wins; else `initial_instruction` from the strategy; else stdin. Whichever comes first, non-empty.
- Safety gate: unchanged. The endpoint's `write_markers`, `max_writes_per_run`, `notional_cap_usd`, and global `DRY_RUN` all still apply. A strategy can advise tighter behavior in prose ("limit to $50 notional") but cannot loosen a code-enforced limit.
- Journal: the endpoint's journal, tagged with the strategy name on `run_start` / `run_end` events. That lets you filter later without splitting state across endpoints.

**Cron-driven runs.** A strategy plus its `initial_instruction` is the full spec for one autonomous execution. Wire this into cron once you're confident:

```cron
35 9 * * 1-5 cd ~/trading-agent && DRY_RUN=false .venv/bin/python agent.py --strategy dca-voo >> logs/dca.log 2>&1
```

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

Common (both transports):

| Field | Required | Purpose |
| --- | --- | --- |
| `transport` | — | `"http"` (default) or `"stdio"`. |
| `prompt_file` | ✅ | Path to the system prompt, relative to the package root. |
| `journal_file` | ✅ | Path to the JSONL journal. |
| `write_markers` | — | Substrings that mark a tool as a write. Empty/omitted = fully read-only endpoint (dry-run is inert). |
| `max_writes_per_run` | — | Cap on allowed writes per run. Omit for unlimited. |
| `notional_cap_usd` | — | Trading only. Requires `quantity` + `limit_price` on every write; refuses if `qty * price` exceeds the cap. |

HTTP transport (`transport: http`):

| Field | Required | Purpose |
| --- | --- | --- |
| `url` | ✅ | Streamable HTTP MCP endpoint. |
| `token_env` | ✅ * | Env var holding the auth token. \* Optional if `auth_header: ''`. |
| `auth_header` | — | HTTP header name. Default `Authorization`. `''` disables auth. |
| `auth_prefix` | — | Literal prefix in the header value. Default `Bearer `. |

Auth-scheme cheatsheet:

| Server pattern | `auth_header` | `auth_prefix` |
| --- | --- | --- |
| OAuth bearer (Robinhood, Linear) | *(default)* | *(default)* |
| Manifold-style `Key <token>` | *(default)* | `Key ` |
| `X-API-Key: <token>` | `X-API-Key` | `` (empty) |
| Unauthenticated | `''` | — |

stdio transport (`transport: stdio`):

| Field | Required | Purpose |
| --- | --- | --- |
| `command` | ✅ | Program to launch (e.g. `npx`, `uvx`, `python`). |
| `args` | — | List of arguments passed to `command`. |

The stdio subprocess inherits the full parent process environment, so any secrets loaded from `.env` are visible to the MCP. Kalshi, for example, reads `KALSHI_API_KEY` and `KALSHI_PRIVATE_KEY_PATH` from env; put them in `.env` and the MCP subprocess picks them up.

### Kalshi setup

Kalshi is real money and CFTC-regulated. There is no first-party hosted MCP; you run one of the community MCPs locally:

- [`IQAIcom/mcp-kalshi`](https://github.com/IQAIcom/mcp-kalshi)
- [`joinQuantish/kalshi-mcp`](https://github.com/joinQuantish/kalshi-mcp)
- [`9crusher/mcp-server-kalshi`](https://github.com/9crusher/mcp-server-kalshi)

Steps:

1. Fund your Kalshi account and generate an API key pair in account settings — you get an API key ID and a private RSA PEM. The private key stays on your machine.
2. Install the chosen MCP (see its README for the exact `npx` / `uvx` invocation).
3. Put both credentials in `.env`:
   ```
   KALSHI_API_KEY=your-key-id
   KALSHI_PRIVATE_KEY_PATH=/absolute/path/to/kalshi-private-key.pem
   ```
4. Uncomment the `kalshi:` block in `endpoints.yaml` and replace `command`/`args` with the invocation from your MCP's README.
5. Run: `python agent.py --endpoint kalshi "Scan liquid contracts and propose one edge."`

`DRY_RUN=true` is the default and will refuse every `create_order` / `cancel_order` call; audit the tool list your MCP advertises against `write_markers` before you flip it.

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
