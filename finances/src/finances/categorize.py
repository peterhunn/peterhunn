"""Rule-based transaction categorization. First matching rule wins."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass


@dataclass
class Rule:
    id: int
    priority: int
    merchant_regex: str | None
    min_amount: float | None
    max_amount: float | None
    account_id: int | None
    set_category_id: int
    set_owner_id: int | None


def load_rules(conn: sqlite3.Connection) -> list[Rule]:
    rows = conn.execute(
        """
        SELECT id, priority, merchant_regex, min_amount, max_amount,
               account_id, set_category_id, set_owner_id
        FROM rules ORDER BY priority ASC, id ASC
        """
    ).fetchall()
    return [Rule(**dict(r)) for r in rows]


def categorize(
    rules: list[Rule],
    merchant_raw: str,
    amount: float,
    account_id: int,
) -> tuple[int | None, int | None]:
    """Return (category_id, owner_id) for the first matching rule."""
    for r in rules:
        if r.merchant_regex:
            if not re.search(r.merchant_regex, merchant_raw, flags=re.IGNORECASE):
                continue
        if r.min_amount is not None and amount < r.min_amount:
            continue
        if r.max_amount is not None and amount > r.max_amount:
            continue
        if r.account_id is not None and r.account_id != account_id:
            continue
        return r.set_category_id, r.set_owner_id
    return None, None
