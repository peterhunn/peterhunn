# Architecture

## Topology

```
   ┌──────────────────────────────────────────────────────────────┐
   │            finances (single process, port 8720)              │
   │                                                              │
   │   ┌────────────┐   ┌─────────────┐   ┌───────────────────┐  │
   │   │ REST + Web │   │ MCP server  │   │  Ingest workers   │  │
   │   │  (FastAPI) │   │  (mounted)  │   │  (Plaid, CSV,     │  │
   │   │            │   │             │   │   Gmail parsing)  │  │
   │   └─────┬──────┘   └──────┬──────┘   └──────────┬────────┘  │
   │         │                 │                     │           │
   │         └─────────────────┴─────────────────────┘           │
   │                          │                                  │
   │              ┌───────────▼────────────┐                     │
   │              │   SQLite (WAL mode)    │                     │
   │              │   ~/.finances/db.db    │                     │
   │              └────────────────────────┘                     │
   └──────────────────────────────────────────────────────────────┘
                   ▲                       ▲                ▲
                   │                       │                │
              browser tab            May (via MCP)     Plaid API
              (localhost)         (over loopback)   (optional, only if
                                                    Plaid is configured)
```

One process, three interfaces (REST, MCP, ingest), one datastore. Runs
under launchd on the Mac. Listens only on `127.0.0.1` — never exposed
to the LAN or the internet.

## Data model

Six core tables. Full DDL in `schema.sql`.

- **`accounts`** — bank / credit card / cash / manual accounts. One row
  per real-world account.
- **`transactions`** — one row per financial event. Immutable once
  ingested; corrections happen via a paired reversal + new row.
- **`categories`** — hierarchical (parent_id nullable). "Groceries"
  under "Food & Household".
- **`budgets`** — one row per (category, month, owner). Owner is a user
  id or the special value `household`.
- **`bills`** — upcoming or recurring obligations, with `due_date`,
  `expected_amount`, `payment_account`, `autopay` flag, `state`
  (upcoming | paid | overdue | canceled).
- **`rules`** — categorization rules. Ordered. First match wins.
  Match on merchant regex / amount range / account.

Plus two lookup tables (`users`, `merchants`) and a `transaction_notes`
side table for annotations that don't belong in the immutable ledger.

## Immutability rule

Transactions ingested from an external source (Plaid, CSV) are
**immutable**. If you need to reclassify or fix an error:

- **Reclassify only?** Update the `category_id` column — that's
  metadata, not the ledger.
- **Wrong amount / duplicate / needs reversal?** Insert a reversal
  transaction (equal + opposite) and a corrected one. The original row
  stays. This is boring bookkeeping practice and makes audits sane.

Manual entries can be edited freely (they were never authoritative).

## Users + auth

Two users seeded by default (`peter`, `shweta`), one shared
`household` view. The web UI has no auth in v1 — it listens on
loopback only and trusts the OS session. If you ever want to reach it
from your phone, put it behind Tailscale + basic auth (documented in
`SETUP.md`).

MCP does not authenticate at the protocol level. The trust boundary
is: only processes on 127.0.0.1 can hit the endpoint, so only the
things you run on that Mac. May inherits that trust.

## Categorization

Two-pass:

1. **Rules pass** — iterate `rules` in order, first match assigns
   category. Rules match on merchant regex, amount range, and/or
   originating account.
2. **Uncategorized queue** — anything left uncategorized surfaces in
   the web UI as "needs review". Click to categorize; the click can
   optionally create a rule ("categorize all future Whole Foods as
   Groceries").

No ML in v1. Rules are readable, editable, diff-able. Add heuristics
if you want in v2.

## Ingest

Three paths, feed the same normalization step:

- **Plaid** — pulls transactions from linked accounts on a cron (default
  every 4 hrs). Deduplicates on Plaid's `transaction_id`. Free
  personal tier; no fees at family volumes.
- **CSV** — one command, drop a file, imported. Provider-specific
  parsers (`csv_import.py`) handle known bank export formats (Chase,
  Amex, Apple Card statement PDFs via a pre-conversion step).
- **Gmail parsing** — reads `office@`, `peter@`, `shweta@` for
  transactional email (receipts, bill notifications), extracts amount
  + merchant + date. Feeds the **bills** table primarily; can also
  seed transactions if the account isn't Plaid-linked. Uses May's
  existing `gog` auth.

All three funnel through `ingest/normalize.py` which enforces the
immutability rule, populates merchant, runs categorization, and writes.

## Service topology & lifecycle

Single Python process. FastAPI + fastmcp + `uv run` for reproducible
deps. Managed by launchd on macOS. Restarts on crash. Logs to
`~/.finances/logs/`.

Backup story: SQLite in WAL mode, `.finances/db.db` covered by Time
Machine. For belt-and-braces, a cron that does
`sqlite3 db.db '.backup /Volumes/Backup/finances/db.db'` nightly.

## Security model (be honest)

- **Loopback only** — never binds to a non-loopback interface without
  explicit config change. `SETUP.md` covers the Tailscale add-on
  correctly if you ever need remote access.
- **Plaid access tokens** — stored in the OS keychain, not in the
  SQLite file, not in config. Rotated per Plaid's cadence.
- **No PII in logs** — merchant names, categories, and amounts log
  fine. Account numbers, tokens, and full addresses are redacted at
  the logger layer.
- **Immutable audit log** for MCP calls — `~/.finances/audit.log`,
  append-only, one line per tool invocation with caller + args + result
  summary. Rotated weekly.
- **v1 has no write-back to Plaid or banks.** Even if you asked
  politely, we don't wire it. That belongs in the money-agent Layer 3
  work with its own dedicated agent boundary — this app is the
  observability + reasoning layer, not the spending layer.
