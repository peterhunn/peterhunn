# SETUP

End-to-end setup on macOS. Assumes you already have Python 3.11+ (comes
with recent macOS) and a working `finances` clone.

## 1. Install

```bash
# uv is the fast pip replacement; if not installed:
curl -LsSf https://astral.sh/uv/install.sh | sh

cd ~/src/finances
uv sync    # installs deps into a local .venv
```

## 2. Configure

```bash
mkdir -p ~/.finances
cp config.example.jsonc  ~/.finances/config.jsonc
cp categories.example.yaml ~/.finances/categories.yaml
$EDITOR ~/.finances/config.jsonc
```

Fill in:

- `dataDir` — where SQLite + logs live (default `~/.finances`)
- `users` — the household members (peter, shweta seed by default)
- `plaid.enabled` — `true` if you want Plaid ingestion, `false` for
  CSV-only
- `plaid.clientId` / `plaid.secret` — from
  https://dashboard.plaid.com/team/keys (free personal tier)
- `plaid.env` — `sandbox` (fake data), `development` (real, 100
  users free), or `production` (needs approval)

## 3. Initialize the database

```bash
uv run finances db init
# creates ~/.finances/db.db, applies schema.sql, seeds users +
# default categories from categories.yaml
```

## 4. First data

Pick one path:

**A. CSV import** (works day-one, no external setup):

```bash
uv run finances import csv examples/sample-transactions.csv
uv run finances import csv ~/Downloads/chase-2026-Q1.csv --account chase-checking
```

Provider-specific format hints in `docs/csv-formats.md`.

**B. Plaid link** (requires Plaid dashboard account):

```bash
uv run finances plaid link
# opens a browser to Plaid Link, connect your bank(s), token is
# stored in the macOS keychain
uv run finances plaid sync
# pulls the last 30 days on first run, incremental after
```

## 5. Run as a service (launchd)

For always-on:

```bash
# generate the launchd plist for your paths + Python
uv run finances launchd install

# start it
launchctl load ~/Library/LaunchAgents/com.hunnfamily.finances.plist

# should now be listening
curl -s http://127.0.0.1:8720/healthz
# → {"ok": true, "version": "0.1.0"}
```

Uninstall: `uv run finances launchd uninstall`.

Or for foreground while developing:

```bash
uv run finances serve --reload
```

## 6. Wire May

Add to May's OpenClaw config (`~/Library/Application Support/openclaw/config.jsonc`):

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

Restart the OpenClaw gateway. Verify:

```bash
openclaw chat "how much did we spend on groceries this month"
# May should call list_transactions + get_budget and answer
```

## 7. Gmail bill parsing (optional, needs May's gog auth already set up)

If you've done May's family EA email setup, bills-from-mail comes free:

```bash
uv run finances bills scan --account peter@hunnfamily.com --days 30
uv run finances bills scan --account office@hunnfamily.com --days 30
# schedule via launchd or openclaw automations to run nightly
```

## 8. Backups

```bash
# nightly snapshot to an external drive
crontab -e
# add:
# 0 2 * * *  sqlite3 ~/.finances/db.db ".backup /Volumes/Backup/finances/db-$(date +\%F).db"
```

Time Machine already covers `~/.finances/` if enabled; the cron gives
you point-in-time restores.

## 9. Reaching it from your phone (optional)

Do NOT open port 8720 to the internet directly. Two acceptable paths:

- **Tailscale** (free personal tier) — install on the Mac + phone,
  reach `http://<mac-tailscale-name>:8720` from anywhere on your
  tailnet. Add HTTP basic auth first (see `docs/remote-access.md`).
- **Cloudflare Tunnel** — free tier, auth via Access. Slightly more
  setup; more security features.

## 10. Verify

```bash
uv run finances doctor
# checks: config valid, db reachable, schema up-to-date, categories
# loaded, MCP endpoint responding, (if Plaid enabled) token valid.
```

## Troubleshooting

- **`sqlite3.OperationalError: database is locked`** — WAL mode should
  prevent this; if you see it, another process is writing. Check for
  a stuck `finances` PID.
- **Plaid `INVALID_ACCESS_TOKEN`** — 90-day re-auth required.
  `uv run finances plaid relink <item-id>` triggers Plaid Link.
- **May can't see the MCP server** — verify OpenClaw's config picks it
  up: `openclaw mcp list`. Then check `curl http://127.0.0.1:8720/mcp/tools`
  returns the tool list.
- **CSV import creates duplicates** — every provider has a stable
  transaction id; if their export doesn't, dedup is best-effort on
  (date, amount, merchant). Prefer Plaid where possible.
