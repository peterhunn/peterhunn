"""Plaid ingest — /transactions/sync with cursor persistence.

Depends on `plaid-python`. Access tokens are kept in the OS keychain via
`keyring`, never in SQLite or config. Kept intentionally thin: the CLI
wraps this; May never calls it directly.
"""

from __future__ import annotations

import sqlite3
from datetime import date

try:
    import keyring
    from plaid import Configuration, ApiClient, Environment
    from plaid.api import plaid_api
    from plaid.model.transactions_sync_request import TransactionsSyncRequest
except Exception:                                    # pragma: no cover
    keyring = None                                    # type: ignore
    Configuration = ApiClient = Environment = None    # type: ignore
    plaid_api = None                                  # type: ignore
    TransactionsSyncRequest = None                    # type: ignore

from ..config import Config
from .normalize import RawTxn, ingest, upsert_account


KEYRING_SERVICE = "finances.plaid.access_token"


def _client(cfg: Config):
    if plaid_api is None:
        raise RuntimeError(
            "plaid-python is not installed. Reinstall deps: `uv sync`."
        )
    env = {
        "sandbox": Environment.Sandbox,
        "development": Environment.Development,
        "production": Environment.Production,
    }[cfg.plaid.env]
    config = Configuration(
        host=env,
        api_key={"clientId": cfg.plaid.client_id, "secret": cfg.plaid.secret},
    )
    return plaid_api.PlaidApi(ApiClient(config))


def _access_token(item_id: str) -> str:
    if keyring is None:
        raise RuntimeError("keyring not installed")
    tok = keyring.get_password(KEYRING_SERVICE, item_id)
    if not tok:
        raise RuntimeError(f"no Plaid access token stored for item {item_id!r}")
    return tok


def store_access_token(item_id: str, token: str) -> None:
    if keyring is None:
        raise RuntimeError("keyring not installed")
    keyring.set_password(KEYRING_SERVICE, item_id, token)


def sync_all_items(conn: sqlite3.Connection, cfg: Config) -> dict:
    """Iterate every linked Plaid item, pull incremental changes."""
    if not cfg.plaid.enabled:
        return {"skipped": True, "reason": "plaid disabled in config"}

    client = _client(cfg)
    totals = {"inserted": 0, "skipped_duplicate": 0, "items": 0}

    items = conn.execute("SELECT id, item_id, cursor FROM plaid_items").fetchall()
    for row in items:
        totals["items"] += 1
        cursor = row["cursor"] or ""
        access_token = _access_token(row["item_id"])
        added, next_cursor = _fetch_page(client, access_token, cursor)

        txns = [
            RawTxn(
                external_id=t["transaction_id"],
                source="plaid",
                date=date.fromisoformat(t["date"]),
                amount=-float(t["amount"]),          # Plaid: positive = outflow
                account_name=_plaid_account_slug(conn, t["account_id"]),
                merchant_raw=t.get("merchant_name") or t.get("name", "unknown"),
                pending=bool(t.get("pending", False)),
            )
            for t in added
        ]
        counts = ingest(conn, txns)
        totals["inserted"] += counts["inserted"]
        totals["skipped_duplicate"] += counts["skipped_duplicate"]

        conn.execute(
            "UPDATE plaid_items SET cursor = ?, last_synced_at = datetime('now') WHERE id = ?",
            (next_cursor, row["id"]),
        )
    return totals


def _fetch_page(client, access_token: str, cursor: str) -> tuple[list[dict], str]:
    """One pass of /transactions/sync. Returns (added, new_cursor)."""
    added: list[dict] = []
    next_cursor = cursor
    while True:
        req = TransactionsSyncRequest(access_token=access_token, cursor=next_cursor)
        resp = client.transactions_sync(req).to_dict()
        added.extend(resp.get("added", []))
        next_cursor = resp.get("next_cursor", next_cursor)
        if not resp.get("has_more"):
            break
    return added, next_cursor


def _plaid_account_slug(conn: sqlite3.Connection, plaid_account_id: str) -> str:
    row = conn.execute(
        "SELECT name FROM accounts WHERE plaid_account_id = ?",
        (plaid_account_id,),
    ).fetchone()
    if row:
        return row["name"]
    slug = f"plaid-{plaid_account_id[:8]}"
    upsert_account(conn, slug, display_name=slug, type_="manual")
    conn.execute(
        "UPDATE accounts SET plaid_account_id = ? WHERE name = ?",
        (plaid_account_id, slug),
    )
    return slug
