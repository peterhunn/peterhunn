"""MCP server exposing the tools May calls.

Mounts under the FastAPI app at /mcp via the MCP HTTP transport.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from mcp.server.fastmcp import FastMCP

from . import queries as q
from .audit import log as audit_log
from .config import Config
from .db import connect


def build_mcp(cfg: Config) -> FastMCP:
    mcp = FastMCP("finances")

    def _db():
        return connect(cfg)

    def _audit(tool: str, args: dict, result_summary: str) -> None:
        try:
            audit_log(cfg.audit.log_file, tool, args, result_summary)
        except Exception:  # pragma: no cover
            pass

    # ─────────────────────  read tools  ─────────────────────

    @mcp.tool()
    def list_transactions(
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
        """List transactions with filters. `since` accepts iso-date, `Nd`, `this-month`, `last-month`."""
        with _db() as c:
            rows = q.list_transactions(
                c, since, until, account, category, merchant, owner,
                min_amount, max_amount, limit,
            )
        _audit("list_transactions", {"since": since, "category": category, "owner": owner}, f"{len(rows)} rows")
        return rows

    @mcp.tool()
    def get_transaction(id: int) -> dict:
        with _db() as c:
            r = q.get_transaction(c, id)
        if not r:
            raise ValueError(f"transaction {id} not found")
        _audit("get_transaction", {"id": id}, "ok")
        return r

    @mcp.tool()
    def summarize_spending(
        since: str,
        until: Optional[str] = None,
        group_by: str = "category",
        owner: Optional[str] = None,
    ) -> list[dict]:
        """Group outflows by category, merchant, account, or owner."""
        with _db() as c:
            rows = q.summarize_spending(c, since, until, group_by, owner)
        _audit("summarize_spending", {"since": since, "group_by": group_by, "owner": owner}, f"{len(rows)} groups")
        return rows

    @mcp.tool()
    def get_budget(month: str, owner: str = "household") -> dict:
        """Get a budget line breakdown for a month (YYYY-MM)."""
        with _db() as c:
            b = q.get_budget(c, month, owner)
        _audit("get_budget", {"month": month, "owner": owner}, f"{len(b.lines)} lines")
        return b.model_dump()

    @mcp.tool()
    def upcoming_bills(within_days: int = 14, state: str = "any") -> list[dict]:
        with _db() as c:
            rows = q.upcoming_bills(c, within_days, state)
        _audit("upcoming_bills", {"within_days": within_days}, f"{len(rows)} bills")
        return rows

    @mcp.tool()
    def list_accounts(active: bool = True) -> list[dict]:
        with _db() as c:
            rows = q.list_accounts(c, active)
        _audit("list_accounts", {"active": active}, f"{len(rows)} accounts")
        return rows

    @mcp.tool()
    def list_categories() -> list[dict]:
        with _db() as c:
            rows = q.list_categories(c)
        _audit("list_categories", {}, f"{len(rows)} categories")
        return rows

    # ─────────────────────  write (metadata only)  ─────────────────────

    @mcp.tool()
    def categorize_transaction(
        transaction_id: int,
        category: str,
        create_rule: bool = False,
    ) -> dict:
        """Reclassify a transaction. Optionally create a rule so future matches auto-categorize."""
        with _db() as c:
            r = q.categorize_transaction(c, transaction_id, category, create_rule)
        _audit("categorize_transaction", {"id": transaction_id, "category": category, "create_rule": create_rule}, "ok")
        return r

    @mcp.tool()
    def annotate_transaction(transaction_id: int, note: str) -> dict:
        with _db() as c:
            r = q.annotate_transaction(c, transaction_id, note)
        _audit("annotate_transaction", {"id": transaction_id}, "ok")
        return r

    @mcp.tool()
    def add_manual_transaction(
        date: str,                       # ISO date
        amount: float,
        merchant: str,
        account: str,
        category: Optional[str] = None,
        owner: str = "household",
        note: Optional[str] = None,
    ) -> dict:
        with _db() as c:
            tid = q.add_manual_transaction(
                c,
                date_=_date(date),
                amount=amount,
                merchant=merchant,
                category=category,
                account=account,
                owner=owner,
                note=note,
            )
            r = q.get_transaction(c, tid)
        _audit("add_manual_transaction", {"merchant": merchant, "amount": amount, "owner": owner}, f"id={tid}")
        return r

    @mcp.tool()
    def add_bill(
        payee: str,
        amount: float,
        due_date: str,
        account: str,
        recurrence: str = "one-off",
        autopay: bool = False,
    ) -> dict:
        with _db() as c:
            bid = q.add_bill(
                c,
                payee=payee,
                amount=amount,
                due_date=_date(due_date),
                account=account,
                recurrence=recurrence,
                autopay=autopay,
            )
        _audit("add_bill", {"payee": payee, "amount": amount, "due_date": due_date}, f"id={bid}")
        return {"id": bid}

    @mcp.tool()
    def update_bill_state(
        bill_id: int,
        state: str,                       # 'paid' | 'canceled'
        paid_amount: Optional[float] = None,
        paid_date: Optional[str] = None,
    ) -> dict:
        with _db() as c:
            q.update_bill_state(
                c, bill_id, state, paid_amount,
                _date(paid_date) if paid_date else None,
            )
        _audit("update_bill_state", {"id": bill_id, "state": state}, "ok")
        return {"ok": True}

    return mcp


def _date(s: str) -> date:
    return date.fromisoformat(s)
