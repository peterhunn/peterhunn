"""Read/write queries shared by REST + MCP. Owner and date-range aware."""

from __future__ import annotations

import re
import sqlite3
from datetime import date, timedelta
from typing import Optional

from dateutil.relativedelta import relativedelta

from .models import Budget, BudgetLine, BudgetTotals


# ─────────────────────────  helpers  ─────────────────────────


def parse_since(s: str) -> date:
    if s == "this-month":
        today = date.today()
        return today.replace(day=1)
    if s == "last-month":
        first_of_this = date.today().replace(day=1)
        return first_of_this - relativedelta(months=1)
    if s.endswith("d"):
        return date.today() - timedelta(days=int(s[:-1]))
    return date.fromisoformat(s)


def parse_until(s: Optional[str]) -> date:
    if not s:
        return date.today() + timedelta(days=1)
    if s.endswith("d"):
        return date.today() - timedelta(days=int(s[:-1]))
    return date.fromisoformat(s)


def _owner_filter(owner: Optional[str]) -> tuple[str, list]:
    if owner is None:
        return "", []
    if owner == "household":
        return " AND t.owner_id IS NULL", []
    return (
        " AND t.owner_id = (SELECT id FROM users WHERE name = ?)",
        [owner],
    )


# ─────────────────────────  transactions  ─────────────────────────


def list_transactions(
    conn: sqlite3.Connection,
    since: str,
    until: Optional[str] = None,
    account: Optional[str] = None,
    category: Optional[str] = None,
    merchant: Optional[str] = None,
    owner: Optional[str] = None,
    min_amount: Optional[float] = None,
    max_amount: Optional[float] = None,
    limit: int = 50,
) -> list[dict]:
    start = parse_since(since).isoformat()
    end = parse_until(until).isoformat()

    where = ["t.date >= ?", "t.date < ?"]
    args: list = [start, end]

    if account:
        where.append("a.name = ?"); args.append(account)
    if category:
        # match on category name or any descendant
        where.append(
            """
            (c.name = ?
             OR c.id IN (
                 WITH RECURSIVE walk(id) AS (
                     SELECT id FROM categories WHERE name = ?
                     UNION ALL
                     SELECT ch.id FROM categories ch, walk WHERE ch.parent_id = walk.id
                 )
                 SELECT id FROM walk
             ))
            """
        )
        args.extend([category, category])
    if merchant:
        where.append("(m.name LIKE ? OR t.merchant_raw LIKE ?)")
        args.extend([f"%{merchant}%", f"%{merchant}%"])
    if min_amount is not None:
        where.append("t.amount >= ?"); args.append(min_amount)
    if max_amount is not None:
        where.append("t.amount <= ?"); args.append(max_amount)

    ownfilt, ownargs = _owner_filter(owner)

    sql = f"""
        SELECT
            t.id, t.date, t.amount, t.source, t.pending,
            COALESCE(m.display_name, m.name, t.merchant_raw) AS merchant,
            c.name AS category,
            a.name AS account,
            u.name AS owner,
            n.note AS note
        FROM transactions t
        JOIN accounts a  ON a.id  = t.account_id
        LEFT JOIN merchants  m ON m.id = t.merchant_id
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN users      u ON u.id = t.owner_id
        LEFT JOIN transaction_notes n ON n.transaction_id = t.id
        WHERE {' AND '.join(where)}{ownfilt}
        ORDER BY t.date DESC, t.id DESC
        LIMIT ?
    """
    rows = conn.execute(sql, [*args, *ownargs, limit]).fetchall()
    return [_txn_row_to_dict(r) for r in rows]


def get_transaction(conn: sqlite3.Connection, tid: int) -> dict | None:
    row = conn.execute(
        """
        SELECT
            t.id, t.date, t.amount, t.source, t.pending,
            COALESCE(m.display_name, m.name, t.merchant_raw) AS merchant,
            c.name AS category,
            a.name AS account,
            u.name AS owner,
            n.note AS note
        FROM transactions t
        JOIN accounts a  ON a.id  = t.account_id
        LEFT JOIN merchants  m ON m.id = t.merchant_id
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN users      u ON u.id = t.owner_id
        LEFT JOIN transaction_notes n ON n.transaction_id = t.id
        WHERE t.id = ?
        """,
        (tid,),
    ).fetchone()
    return _txn_row_to_dict(row) if row else None


def _txn_row_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "date": r["date"],
        "amount": r["amount"],
        "merchant": r["merchant"],
        "category": r["category"],
        "account": r["account"],
        "owner": r["owner"] or "household",
        "source": r["source"],
        "note": r["note"],
        "pending": bool(r["pending"]),
    }


# ─────────────────────────  spending summary  ─────────────────────────


def summarize_spending(
    conn: sqlite3.Connection,
    since: str,
    until: Optional[str] = None,
    group_by: str = "category",
    owner: Optional[str] = None,
) -> list[dict]:
    start = parse_since(since).isoformat()
    end = parse_until(until).isoformat()

    key_expr = {
        "category": "COALESCE(c.name, 'Uncategorized')",
        "merchant": "COALESCE(m.display_name, m.name, t.merchant_raw)",
        "account": "a.name",
        "owner": "COALESCE(u.name, 'household')",
    }.get(group_by, "COALESCE(c.name, 'Uncategorized')")

    ownfilt, ownargs = _owner_filter(owner)

    # negate amount so 'total' is spend-positive (outflows)
    sql = f"""
        SELECT {key_expr} AS key,
               ROUND(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 2) AS total,
               COUNT(*) AS count
        FROM transactions t
        JOIN accounts a  ON a.id  = t.account_id
        LEFT JOIN merchants  m ON m.id = t.merchant_id
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN users      u ON u.id = t.owner_id
        WHERE t.date >= ? AND t.date < ?{ownfilt}
        GROUP BY key
        HAVING total > 0
        ORDER BY total DESC
    """
    rows = conn.execute(sql, [start, end, *ownargs]).fetchall()
    return [{"key": r["key"], "total": r["total"], "count": r["count"]} for r in rows]


# ─────────────────────────  budgets  ─────────────────────────


def get_budget(conn: sqlite3.Connection, month: str, owner: str = "household") -> Budget:
    start, end = _month_bounds(month)
    ownid = _resolve_owner(conn, owner)

    lines_sql = """
        SELECT
            c.name AS category,
            COALESCE(SUM(b.amount), 0)              AS budgeted,
            COALESCE(SUM(spent.spent), 0)           AS actual
        FROM categories c
        LEFT JOIN budgets b
               ON b.category_id = c.id
              AND b.month       = ?
              AND (b.owner_id IS ? OR b.owner_id = ?)
        LEFT JOIN (
            SELECT t.category_id,
                   SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) AS spent
            FROM transactions t
            WHERE t.date >= ? AND t.date < ?
              AND (t.owner_id IS ? OR t.owner_id = ?)
            GROUP BY t.category_id
        ) spent ON spent.category_id = c.id
        WHERE b.amount IS NOT NULL OR spent.spent IS NOT NULL
        GROUP BY c.id, c.name
        ORDER BY c.name
    """
    rows = conn.execute(
        lines_sql,
        (month, ownid, ownid, start.isoformat(), end.isoformat(), ownid, ownid),
    ).fetchall()

    lines: list[BudgetLine] = []
    tot_b = tot_a = 0.0
    for r in rows:
        b = float(r["budgeted"] or 0)
        a = float(r["actual"] or 0)
        rem = b - a
        pct = round((a / b) * 100, 1) if b > 0 else 0.0
        lines.append(
            BudgetLine(
                category=r["category"],
                budgeted=round(b, 2),
                actual=round(a, 2),
                remaining=round(rem, 2),
                pct_used=pct,
                over_budget=(b > 0 and a > b),
            )
        )
        tot_b += b; tot_a += a

    return Budget(
        month=month,
        owner=owner,  # type: ignore[arg-type]
        lines=lines,
        totals=BudgetTotals(
            budgeted=round(tot_b, 2),
            actual=round(tot_a, 2),
            remaining=round(tot_b - tot_a, 2),
        ),
    )


def _month_bounds(month: str) -> tuple[date, date]:
    y, m = month.split("-")
    start = date(int(y), int(m), 1)
    end = start + relativedelta(months=1)
    return start, end


def _resolve_owner(conn: sqlite3.Connection, owner: str) -> int | None:
    if owner == "household":
        return None
    r = conn.execute("SELECT id FROM users WHERE name = ?", (owner,)).fetchone()
    return r["id"] if r else None


# ─────────────────────────  bills  ─────────────────────────


def upcoming_bills(
    conn: sqlite3.Connection,
    within_days: int = 14,
    state: str = "any",
) -> list[dict]:
    horizon = (date.today() + timedelta(days=within_days)).isoformat()
    state_filter, args = "", [horizon]
    if state == "upcoming":
        state_filter = " AND b.state = 'upcoming'"
    elif state == "overdue":
        state_filter = " AND b.state = 'overdue'"
    rows = conn.execute(
        f"""
        SELECT b.id, b.payee, b.amount, b.due_date, b.paid_date, b.paid_amount,
               b.recurrence, b.autopay, b.state, a.name AS account
        FROM bills b
        LEFT JOIN accounts a ON a.id = b.payment_account_id
        WHERE b.due_date <= ?{state_filter}
          AND b.state IN ('upcoming','overdue')
        ORDER BY b.due_date ASC
        """,
        args,
    ).fetchall()
    return [dict(r) for r in rows]


# ─────────────────────────  writes (metadata only)  ─────────────────────────


def categorize_transaction(
    conn: sqlite3.Connection,
    txn_id: int,
    category: str,
    create_rule: bool = False,
) -> dict:
    row = conn.execute(
        "SELECT id FROM categories WHERE name = ?", (category,)
    ).fetchone()
    if not row:
        raise ValueError(f"unknown category: {category!r}")
    cid = row["id"]
    conn.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (cid, txn_id))

    rule_created = False
    if create_rule:
        merchant = conn.execute(
            "SELECT merchant_raw FROM transactions WHERE id = ?", (txn_id,)
        ).fetchone()
        if merchant:
            escaped = re.escape(merchant["merchant_raw"])
            conn.execute(
                "INSERT INTO rules (priority, merchant_regex, set_category_id, note) "
                "VALUES (?, ?, ?, ?)",
                (50, escaped, cid, f"auto-created from txn {txn_id}"),
            )
            rule_created = True
    return {"ok": True, "rule_created": rule_created}


def annotate_transaction(conn: sqlite3.Connection, txn_id: int, note: str) -> dict:
    conn.execute(
        "INSERT INTO transaction_notes (transaction_id, note) VALUES (?, ?)",
        (txn_id, note),
    )
    return {"ok": True}


def add_manual_transaction(
    conn: sqlite3.Connection,
    *,
    date_: date,
    amount: float,
    merchant: str,
    category: Optional[str],
    account: str,
    owner: str,
    note: Optional[str],
) -> int:
    acct = conn.execute("SELECT id FROM accounts WHERE name = ?", (account,)).fetchone()
    if not acct:
        raise ValueError(f"unknown account: {account!r}")
    cid = None
    if category:
        r = conn.execute("SELECT id FROM categories WHERE name = ?", (category,)).fetchone()
        cid = r["id"] if r else None
    oid = _resolve_owner(conn, owner)

    cur = conn.execute(
        """
        INSERT INTO transactions
          (source, date, amount, account_id, merchant_raw, category_id, owner_id)
        VALUES ('manual', ?, ?, ?, ?, ?, ?)
        """,
        (date_.isoformat(), amount, acct["id"], merchant, cid, oid),
    )
    tid = cur.lastrowid
    if note:
        annotate_transaction(conn, tid, note)
    return tid


def add_bill(
    conn: sqlite3.Connection,
    *,
    payee: str,
    amount: float,
    due_date: date,
    account: str,
    recurrence: str = "one-off",
    autopay: bool = False,
) -> int:
    acct = conn.execute("SELECT id FROM accounts WHERE name = ?", (account,)).fetchone()
    if not acct:
        raise ValueError(f"unknown account: {account!r}")
    cur = conn.execute(
        """
        INSERT INTO bills (payee, amount, due_date, payment_account_id, recurrence, autopay)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (payee, amount, due_date.isoformat(), acct["id"], recurrence, int(autopay)),
    )
    return cur.lastrowid


def update_bill_state(
    conn: sqlite3.Connection,
    bill_id: int,
    state: str,
    paid_amount: Optional[float] = None,
    paid_date: Optional[date] = None,
) -> None:
    conn.execute(
        """
        UPDATE bills SET state = ?, paid_amount = ?, paid_date = ?
        WHERE id = ?
        """,
        (state, paid_amount, paid_date.isoformat() if paid_date else None, bill_id),
    )


# ─────────────────────────  accounts + categories  ─────────────────────────


def list_accounts(conn: sqlite3.Connection, active: bool = True) -> list[dict]:
    sql = "SELECT id, name, display_name, type, active FROM accounts"
    if active:
        sql += " WHERE active = 1"
    return [dict(r) for r in conn.execute(sql).fetchall()]


def list_categories(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT id, name, parent_id FROM categories ORDER BY parent_id NULLS FIRST, name"
    ).fetchall()
    by_id = {r["id"]: dict(r) for r in rows}
    for c in by_id.values():
        c["full_path"] = _full_path(c["id"], by_id)
    return list(by_id.values())


def _full_path(cid: int, index: dict[int, dict]) -> str:
    parts = []
    cur = index.get(cid)
    while cur:
        parts.append(cur["name"])
        cur = index.get(cur["parent_id"]) if cur["parent_id"] else None
    return " / ".join(reversed(parts))
