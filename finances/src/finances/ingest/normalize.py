"""Shared write path for all ingested transactions.

Enforces:
  - immutability (idempotent on external_id)
  - merchant upsert
  - rule-based categorization
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from ..categorize import categorize, load_rules


@dataclass
class RawTxn:
    external_id: str | None
    source: str                     # 'plaid' | 'csv' | 'manual' | 'gmail'
    date: date
    amount: float                   # negative = outflow
    account_name: str               # short slug matching accounts.name
    merchant_raw: str
    currency: str = "USD"
    pending: bool = False


def upsert_account(
    conn: sqlite3.Connection,
    name: str,
    display_name: str | None = None,
    type_: str = "manual",
) -> int:
    row = conn.execute("SELECT id FROM accounts WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO accounts (name, display_name, type) VALUES (?, ?, ?)",
        (name, display_name or name, type_),
    )
    return cur.lastrowid


def upsert_merchant(conn: sqlite3.Connection, name: str) -> int:
    n = name.strip()
    row = conn.execute("SELECT id FROM merchants WHERE name = ?", (n,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("INSERT INTO merchants (name) VALUES (?)", (n,))
    return cur.lastrowid


def ingest(conn: sqlite3.Connection, txns: list[RawTxn]) -> dict:
    """Insert a batch of transactions. Returns counts."""
    rules = load_rules(conn)
    inserted = skipped = 0
    for t in txns:
        if t.external_id:
            existing = conn.execute(
                "SELECT id FROM transactions WHERE external_id = ?",
                (t.external_id,),
            ).fetchone()
            if existing:
                skipped += 1
                continue

        acct_id = upsert_account(conn, t.account_name)
        merch_id = upsert_merchant(conn, t.merchant_raw)
        cat_id, own_id = categorize(rules, t.merchant_raw, t.amount, acct_id)

        conn.execute(
            """
            INSERT INTO transactions
              (external_id, source, date, amount, currency, account_id,
               merchant_id, merchant_raw, category_id, owner_id, pending)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                t.external_id, t.source, t.date.isoformat(), t.amount, t.currency,
                acct_id, merch_id, t.merchant_raw, cat_id, own_id, int(t.pending),
            ),
        )
        inserted += 1
    return {"inserted": inserted, "skipped_duplicate": skipped}
