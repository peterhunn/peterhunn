# finances

Local-first household finance tracking for the Hunn family. Runs on the
same Mac as May (or on its own box); May calls it over MCP for reads
and drafts; you and Shweta hit its localhost web UI for eyes-on.

Zero cloud dependencies except optional Plaid for bank/card aggregation
(free personal tier; skip if you'd rather CSV-import).

## Scope (v1)

Three things, done well:

1. **Transactions** — ingest from Plaid or CSV, categorize with a rules
   engine you can hand-edit, search / filter / annotate
2. **Budgets** — monthly budget per category, actual vs planned, roll-up
   by household / by person
3. **Bills** — upcoming bills tracked from Gmail parsing or manual entry,
   due dates, auto-pay verification

Not in v1 (see `ROADMAP.md`): net worth, investments, subscription
audit, tax aggregation, mobile app.

## Quick start

```bash
git clone https://github.com/peterhunn/finances.git
cd finances

# uv is a drop-in fast pip; if you don't have it: pip install uv
uv sync

# copy + edit config
cp config.example.jsonc ~/.finances/config.jsonc
cp categories.example.yaml ~/.finances/categories.yaml
$EDITOR ~/.finances/config.jsonc     # set data dir, users, Plaid (optional)

# init the database
uv run finances db init

# import a CSV to prove the pipeline works
uv run finances import csv examples/sample-transactions.csv

# start the API + MCP + web UI (all one process, port 8720)
uv run finances serve
# → REST + web UI at http://127.0.0.1:8720
# → MCP endpoint at http://127.0.0.1:8720/mcp
```

## How May uses it

May's OpenClaw config gets one MCP block:

```jsonc
{
  "mcp": {
    "servers": {
      "finances": {
        "transport": "http",
        "url": "http://127.0.0.1:8720/mcp"
      }
    }
  }
}
```

Then in a chat: "how much did we spend on groceries this month" hits
`list_transactions` + `get_budget`, "what bills are due this week" hits
`upcoming_bills`, etc. See `mcp-tools.md` for the full tool surface.

## Docs

- **[SETUP.md](SETUP.md)** — full setup end to end, including running as a
  background service via `launchd`
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — data model, service topology,
  security model
- **[ROADMAP.md](ROADMAP.md)** — v1 → v2 → v3
- **[mcp-tools.md](mcp-tools.md)** — the typed tool surface May calls
