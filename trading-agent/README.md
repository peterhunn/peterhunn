# MCP-Connected Agent

A Python agent that drives Claude against any MCP (Model Context Protocol) endpoint declared in `endpoints.yaml`. Ships with profiles for Robinhood, Linear, Manifold, and a commented Kalshi example. New endpoints are YAML + a prompt file — no code changes.

The directory is called `trading-agent/` for historical reasons; it is no longer trading-specific.

## What it does

- Opens an MCP session (Streamable HTTP or stdio) to the endpoint you pick.
- Lists that endpoint's tools and exposes them to Claude via the Messages API `tools=[...]` parameter, so every tool call passes through this process.
- Runs an adaptive-thinking agent loop.
- Enforces per-endpoint safety rules in code (dry-run, write count cap, optional notional cap) before any mutating tool reaches the server; refused calls come back to Claude as errors so it can adapt.
- Journals every event to a per-endpoint JSONL file. The tail is injected into the next run's system prompt so the agent has continuity across sessions.
- Optionally posts webhook notifications on live writes, refusals, and live run summaries.

---

## Quickstart

Five steps. **Do not skip the dry-run stage.** See [Readiness checklist](#readiness-checklist) before flipping any endpoint to live.

### 1. Install

Requires Python ≥ 3.10 and an Anthropic API key.

```bash
cd trading-agent
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e .
cp .env.example .env
```

Put your Anthropic API key in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Pick an endpoint

The framework ships four example endpoints. Do full setup for **one** first; you can add others later.

| Endpoint | Auth | Setup effort | Real or play |
| --- | --- | --- | --- |
| **manifold** | API key | 5 min | Play money — **best first choice** |
| **linear** | OAuth token | 10 min | Real ops mutations |
| **robinhood** | OAuth token | 15 min | Real money (equities only) |
| **kalshi** | RSA key pair + local MCP subprocess | 30 min | Real money (event contracts) |

Detailed per-endpoint setup is in [Endpoint setup](#endpoint-setup) below.

### 3. Confirm the tool list matches your write markers

The single biggest failure mode is that the endpoint's real tool names don't match the `write_markers` heuristic in `endpoints.yaml`. Audit them **before** you ever set `DRY_RUN=false`:

```bash
python agent.py --endpoint <name> "List every tool you have available. \
  For each, one sentence on what it does. Do not call anything else."
```

Read the stderr line `[mcp] connected via ... — N tools`; then compare the tool names in Claude's answer to your endpoint's `write_markers`. Every mutating tool must contain at least one marker as a substring. If any don't (e.g. `zap_position` when your markers are `place_, submit_, cancel_`), edit `endpoints.yaml` and add the missing marker before proceeding.

### 4. Run in dry-run

`DRY_RUN=true` is the default. Nothing mutating will actually execute; the safety gate returns errors instead. Do at least five dry-run cycles and read the journal:

```bash
python agent.py --endpoint <name> "Review my account and propose one action."
cat journals/<name>.jsonl | tail -20
```

Or use the web UI:

```bash
python agent.py --web
# opens http://127.0.0.1:8765 — pick the endpoint, chat, watch the History tab
```

### 5. Go live (per endpoint, deliberately)

Only after step 4:

1. **Fund the endpoint conservatively.** For Robinhood, put in the Agentic account the maximum you're prepared to lose. Robinhood's MCP restricts trading to that account; your main brokerage cannot be touched.
2. **Set a webhook** so you find out immediately when a real write happens (see [Notifications](#notifications)).
3. Flip `DRY_RUN=false` in `.env`.
4. Do a single live run with a tightly-scoped instruction. Verify the notification arrived, the journal recorded the write, and the endpoint's UI shows the result.
5. Only then consider cron / recurring runs.

---

## Endpoint setup

### Robinhood

**Prerequisites**
- A Robinhood account with an Agentic account opened, funded, and an AI agent authorized. Complete this on a desktop browser: <https://robinhood.com/us/en/support/articles/agentic-trading-overview/>. This step **must** happen before anything below.
- Equities only as of mid-2026. Event contracts / options are on their roadmap.

**Get the OAuth bearer token**
1. `npm install -g @anthropic-ai/claude-code`
2. `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading` and complete the browser OAuth flow it prints.
3. Locate the token. On macOS/Linux it's typically in `~/.claude/` (grep for `robinhood-trading` or `Bearer` there). Copy the string that comes after `Bearer `.
4. Put it in `.env`:
   ```
   ROBINHOOD_MCP_TOKEN=<the-token>
   ```

Tokens expire — re-run the `claude mcp add` flow when Robinhood starts returning 401s.

**Try it**
```bash
python agent.py --endpoint robinhood "Show my Agentic account balance."
```

**Before flipping DRY_RUN=false**
- Audit `write_markers` per step 3 of the Quickstart. Robinhood's current marker list is `[place_, submit_, cancel_, modify_, replace_order, buy, sell]` — if any of Robinhood's tools use different verbs, add them.
- Consider a tighter per-strategy cap (see [Per-strategy safety overrides](#per-strategy-safety-overrides)).

### Manifold Markets (recommended first)

Play money, single-header auth, hosted server. Best for getting the whole loop working before touching real money.

1. Log in to <https://manifold.markets> and copy your API key from your profile page.
2. In `.env`:
   ```
   MANIFOLD_API_KEY=<your-key>
   ```
3. **Community MCP required.** There is no first-party hosted Manifold MCP as of mid-2026. Either run one (search "manifold mcp server" on GitHub) or note the placeholder URL in `endpoints.yaml` needs to be replaced with whatever MCP you use. Manifold's own REST API is well-documented so a thin MCP wrapper is straightforward if you can't find one.
4. Update `endpoints.yaml`'s `manifold.url` to your MCP's URL.

```bash
python agent.py --endpoint manifold "Show my mana balance and open positions."
```

### Linear

1. `claude mcp add linear-workspace --transport http https://mcp.linear.app/mcp` and complete the OAuth flow.
2. Extract the bearer token from `~/.claude/` and put in `.env`:
   ```
   LINEAR_MCP_TOKEN=<the-token>
   ```

```bash
python agent.py --endpoint linear "List my open issues assigned to me."
```

### Kalshi (stdio, community MCP)

Kalshi's own auth uses RSA-signed requests, so all community MCPs run as **local subprocesses**. The RSA key never leaves your machine — the subprocess signs each request and this framework just talks to it over stdio.

1. Fund your Kalshi account and generate an API key pair in account settings. You get a **key ID** and a **private RSA PEM file**.
2. Install a community MCP. Two options:
   - [`IQAIcom/mcp-kalshi`](https://github.com/IQAIcom/mcp-kalshi)
   - [`joinQuantish/kalshi-mcp`](https://github.com/joinQuantish/kalshi-mcp)

   Follow the MCP's README for the exact `npx`/`uvx`/`pip install` invocation.

3. Put the credentials in `.env`:
   ```
   KALSHI_API_KEY=<the-key-id>
   KALSHI_PRIVATE_KEY_PATH=/absolute/path/to/kalshi-private-key.pem
   ```
   Both are inherited by the stdio subprocess automatically.
4. Uncomment the `kalshi:` block in `endpoints.yaml` and swap `command`/`args` for whatever your chosen MCP prescribes.
5. Uncomment `# KALSHI_API_KEY=` and `# KALSHI_PRIVATE_KEY_PATH=` lines in `.env.example` if using the shipped template.

```bash
python agent.py --endpoint kalshi "Scan liquid contracts for edges > 8 percentage points."
```

### Adding your own endpoint

See [Adding a new endpoint](#adding-a-new-endpoint) below. Short version: append a block to `endpoints.yaml`, set the token env var in `.env`, write `prompts/<name>.md`, run `python agent.py --endpoint <name> "..."`.

---

## Common workflows

**One-shot query against an endpoint:**
```bash
python agent.py --endpoint <name> "Your instruction here."
```

**Design a strategy in the browser (no YAML typing):**
```bash
python agent.py --web
# → Pick endpoint, chat, /save via the button, edit inline
```

**Design a strategy in the terminal:**
```bash
python agent.py --endpoint robinhood --design-strategy
# → /save, /edit, /show, /quit
```

**Run a saved strategy:**
```bash
python agent.py --strategy dca-voo               # uses initial_instruction
python agent.py --strategy dca-voo "Skip if SPY is below its 50-day MA."
```

**Review a strategy's history:**
Open the web UI, load the strategy, click the History tab. Or read `journals/<endpoint>.jsonl` directly.

**Turn a strategy on/off:**
Web UI toggle pill, or manually set `enabled: false` in `strategies.yaml`. A disabled strategy refuses to run unless you pass `--force`.

**Have Claude propose new strategies:**
```bash
python agent.py --endpoint robinhood --propose-strategy \
  "Watch my positions and suggest 2 strategies I could formalize."
# read-only, outputs YAML at the end; paste what you want into strategies.yaml
```

**Have Claude reflect on a strategy's history:**
```bash
python agent.py --strategy dca-voo --reflect
# read-only, proposes one edit to the prompt_addendum
```

**Schedule with cron:**
```cron
35 9 * * 1-5 cd ~/trading-agent && DRY_RUN=false .venv/bin/python agent.py --strategy dca-voo >> logs/dca.log 2>&1
```
Start with `DRY_RUN=true` in cron for a week; check the logs and webhook history; only then arm.

---

## Readiness checklist

Before setting `DRY_RUN=false` on any endpoint, verify all of these:

- [ ] `pip install -e .` completes clean in a fresh venv.
- [ ] `python agent.py --list-endpoints` shows what you expect.
- [ ] `python agent.py --web` renders correctly and lets you toggle a strategy.
- [ ] You've done a full dry-run cycle against the endpoint and read the resulting journal entry.
- [ ] You've audited the discovered tool list against the endpoint's `write_markers` (see Quickstart step 3).
- [ ] The endpoint's account is funded with an amount you're comfortable losing entirely.
- [ ] A webhook is configured and you've verified a test event reaches it.
- [ ] For strategies: `notional_cap_usd` and `max_writes_per_run` are set tighter than the endpoint's ceiling if you want stricter per-strategy limits.
- [ ] For strategies with `initial_instruction`: run manually in dry-run first to confirm the instruction is well-scoped.

---

## Troubleshooting

**`Missing required env var ROBINHOOD_MCP_TOKEN`**
The env var isn't loaded. Check `.env` exists and contains the var (no quotes needed), and that you started the CLI from the `trading-agent/` directory. `python-dotenv` loads `.env` at process start.

**Every write refused with "harness could not compute notional"**
Your endpoint has `notional_cap_usd` set but the tool arguments don't include a recognized quantity/price field. Either add a `limit_price` to your instruction (e.g. "at a limit near the ask"), or expand `_pick(args, ...)` in `safety.py` to include the field names your endpoint actually uses.

**`refused to run: strategy 'X' is disabled`**
The strategy has `enabled: false` in `strategies.yaml`. Toggle in the web UI, edit the file directly, or run once with `--force`.

**HTTP 401 on the first tool call**
OAuth token expired. Re-run `claude mcp add <name> --transport http <url>` and copy the new token into `.env`.

**Kalshi MCP subprocess exits immediately**
The subprocess couldn't find `KALSHI_API_KEY` or the PEM path. Confirm both are in `.env` and the PEM path is absolute and readable. Test the MCP directly per its own README before wiring it here.

**Web UI loads but chat 502s**
Look at the terminal running `python agent.py --web` — the exception is printed there. Common causes: invalid Anthropic API key, network to `api.anthropic.com` blocked, or the strategy's prompt file has a placeholder like `{unknown_var}` that fails string formatting.

**No history in the History tab**
Either the strategy has never run (dry-runs count — did you run at all?), or the endpoint's journal is at a different path than `journals/<endpoint>.jsonl`. Check the endpoint's `journal_file` in `endpoints.yaml`.

**Notifications not arriving**
Confirm `notify_webhook_env` in `endpoints.yaml` points at a var actually set in `.env`. Confirm the URL accepts POSTs (test with `curl -X POST <url> -H "Content-Type: application/json" -d '{"text":"test"}'`). Read stderr — notification failures log there.

---

## Web UI (browser strategy designer)

```bash
python agent.py --web            # opens http://127.0.0.1:8765 automatically
python agent.py --web --web-port 9000 --web-no-browser
```

Two-pane layout with tabs on the right:

- **Left**: chat with Claude. YAML in replies is extracted and pushed to the right pane.
- **Right, YAML tab**: live-editable draft. Save merges into `strategies.yaml` (add or replace by strategy key).
- **Right, History tab**: per-run cards for the loaded strategy, plus summary stats (total runs, total writes, total cost, avg cost per run, last run). Each card shows mode badge (LIVE / DRY-RUN / PROPOSE / REFLECT), stop reason, writes used, cost, the instruction, tool calls made, calls blocked by the safety gate, tool errors, refusals, and the final assistant text.

**Top bar controls:**
- Endpoint dropdown (from `endpoints.yaml`).
- Strategy dropdown — `— new —` or an existing strategy. Disabled strategies show `[off]` after the name.
- **Enable/disable pill**: click to toggle the selected strategy on or off. Live = green, disabled = red. Writes `enabled: true|false` directly into `strategies.yaml`.

**Effect of disabling.** A disabled strategy is refused at the CLI:

```bash
$ python agent.py --strategy dca-voo
strategy 'dca-voo' is disabled (enabled: false in strategies.yaml).
Toggle it back on in the web UI, edit the YAML directly, or pass
--force to override just this run.
```

`--force` overrides for a single run. Read-only meta modes (`--propose-strategy`, `--reflect`) still work on disabled strategies (they don't execute anything).

Binds to `127.0.0.1` only. No auth — do not expose to a network.

## Authoring strategies in natural language (no YAML typing)

`--design-strategy` opens an interactive conversation. Claude asks what
you want; you answer in plain English; Claude emits YAML as it goes; you
refine by talking back. `/save` writes the current draft to
`strategies.yaml` and opens `$EDITOR` on the file for a final polish.

```bash
# New strategy on Robinhood
python agent.py --endpoint robinhood --design-strategy

# Pre-fill a name (creates or edits, depending on whether it exists)
python agent.py --endpoint kalshi --design-strategy ev-positive-kalshi

# Edit an existing strategy — endpoint is inferred from the strategy
python agent.py --design-strategy dca-voo
```

Slash commands inside the designer:

| Command | Action |
| --- | --- |
| `/save` | Append the current YAML draft to `strategies.yaml`, then open `$EDITOR`. |
| `/edit` | Open `strategies.yaml` in `$EDITOR` now, no save. |
| `/show` | Print the current YAML draft. |
| `/quit` | Exit without saving. |

The designer needs a TTY (interactive shell) and reads from stdin. `$EDITOR`/`$VISUAL` picks the editor; falls back to `nano`/`vim`/`vi`/`code`. Existing strategies are hand-editable in `strategies.yaml` at any time — the designer is a fast path, not the only path.

## Notifications

Silent autonomous runs are the failure mode you can't recover from. Add a webhook to any endpoint and the agent will POST notable events to it in real time:

- **`live_write`** — a mutating tool actually executed against the MCP (`DRY_RUN=false`, safety gate allowed).
- **`refusal`** — the model refused for safety reasons.
- **`live_run_summary`** — end of a live run where at least one write happened.

Config in `endpoints.yaml`:

```yaml
robinhood:
  ...
  notify_webhook_env: ROBINHOOD_WEBHOOK_URL
```

Then in `.env`:

```
ROBINHOOD_WEBHOOK_URL=https://hooks.slack.com/services/T00/B00/xxx
```

The payload is Slack-compatible (has a `text` field), so Slack incoming webhooks work with no adapter. Custom receivers can key on the `event` field:

```json
{
  "text": "[robinhood/dca-voo] LIVE_WRITE: place_equity_order({\"symbol\":\"VOO\",\"quantity\":1,\"limit_price\":482})",
  "endpoint": "robinhood",
  "strategy": "dca-voo",
  "event": "live_write",
  "message": "...",
  "details": {"tool": "place_equity_order", "args": {...}}
}
```

Notifications are best-effort — failures log to stderr and never break the run. Read-only paths (`--propose-strategy`, `--reflect`, dry-run) never notify.

## Per-strategy safety overrides

`notional_cap_usd` and `max_writes_per_run` are enforced per-endpoint by default, but a strategy can tighten them for itself:

```yaml
strategies:
  dca-voo:
    endpoint: robinhood            # endpoint's cap is $250, 3 writes
    notional_cap_usd: 50           # this strategy caps at $50
    max_writes_per_run: 1          # ...and 1 write per run
    prompt_addendum: |
      ...
```

**Overrides must tighten, not loosen.** A strategy setting `notional_cap_usd: 500` on an endpoint whose cap is `250` is rejected at load time with a clear error — the endpoint's cap is the ceiling. This lets you keep one endpoint (one Robinhood connection, one Kalshi worker) shared across strategies with different risk budgets.

The safety gate reports which layer caught the block:

```
BLOCKED by harness: max_writes_per_run (1, from strategy) already reached.
```

## Cost accounting

Every `run_end` in `journals/<endpoint>.jsonl` now records:

```json
{
  "type": "run_end",
  "usage": {"input_tokens": 12403, "output_tokens": 1847, "cache_read_input_tokens": 8192, "cache_creation_input_tokens": 0},
  "cost_usd": 0.1082
}
```

Pricing lives in `pricing.py` (USD per 1M tokens per model). The recent-history block injected into the next run's system prompt now leads with:

```
Recent per-run cost across 12 runs: avg $0.0421, min $0.0093, max $0.1174
```

Strategies can reason about their own operating cost — the `ev-positive-kalshi` example uses this to compute break-even order sizes.

## Delegating strategy design to the LLM

Two meta-modes let Claude help you author and improve strategies. Both are **read-only** — they force `DRY_RUN=true`, and the SafetyGate refuses any tool call whose name doesn't match a conservative read allowlist (`get_*`, `list_*`, `search_*`, `read_*`, `fetch_*`, `quote_*`, etc.), regardless of the endpoint's `write_markers`. The LLM cannot execute; it can only propose.

**Propose new strategies:**

```bash
python agent.py --endpoint robinhood --propose-strategy \
  "Watch what I hold, then suggest 2 strategies I could formalize."
# → Claude reads positions, orders, popular lists, etc. and ends with a
# → YAML block. You diff it against strategies.yaml and paste what you like.
```

**Reflect on an existing strategy:**

```bash
python agent.py --strategy dca-voo --reflect
# → Claude reads only this strategy's history from the journal, critiques
# → what worked and what didn't, and proposes one concrete edit to the
# → prompt_addendum. Same YAML-block output pattern.
```

The proposal / critique is text — nothing is auto-applied. Human review is the entire point: the LLM does the analysis, you decide what enters `strategies.yaml`. Self-modifying strategies (agent editing its own prompt without a human gate) are deliberately not built.

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
