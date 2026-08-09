# Roadmap

## v1 — Foundation, Budgets, Bills (current)

- Transactions ingest (Plaid, CSV, Gmail parsing)
- Rules-based categorization
- Monthly budgets per category per owner
- Bill tracking + auto-pay verification
- REST + web UI + MCP server, all one process
- SQLite storage, launchd-managed

Success looks like: after one month of use, you can answer "how much
did we spend on X" and "what bills are coming up" in under 5 seconds,
without opening a bank website.

## v2 — Net worth + subscriptions

- **Account balances over time** — track balances (not just
  transactions) across bank + credit + investment + cash accounts
- **Property valuation** — manual entry with periodic Zestimate refresh
- **Investment holdings** — read-only positions via Plaid Investments
  endpoint or manual entry
- **Net worth series** — monthly snapshot, chart in the web UI
- **Subscription detection** — "you've paid Y monthly for 8 months —
  active subscription?" Confirmation UI to mark active / cancel /
  keep-monitoring
- **Anomaly detection** — heuristic flags (charge > 2× rolling avg,
  new merchant with high amount)

## v3 — Household intelligence

- **Cashflow projection** — given upcoming bills + typical spend +
  known income, project account balances 30/60/90 days out
- **Alert routing** — per-user alert rules ("ping Shweta on any
  amount > $500 on shared cards", "morning brief includes bills due
  this week")
- **Yearly aggregation** — export tax-ready summaries; category
  totals by year; receipts collected from Gmail auto-tagged
- **Multi-currency** — for the day travel becomes routine (GBP + USD)

## v4 — Delegated actions (with money-agent boundary)

The point where this app crosses from observability into
initiating-payments. Only after v1-v3 are rock solid, and only via the
dedicated finance-agent MCP boundary described in
`agent/roadmap/money-agent.md`. This app **remains the observability +
reasoning layer**; a separate service with its own credentials, caps,
and audit log does the actual money-moving.

## Not planned

- Mobile app. Web UI is responsive; PWA is enough. iOS/Android native
  is not on the table.
- Cloud sync. If you want multi-device, put this on a Mac mini on
  Tailscale and reach it from everywhere.
- ML categorization. Rules are fine and human-readable.
- Public / hosted version. This is single-household; commercializing
  it is a different project.
