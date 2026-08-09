"""FastAPI REST + web UI routes."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from . import __version__
from .config import Config
from .db import connect
from . import queries as q


def build_api(cfg: Config) -> FastAPI:
    app = FastAPI(title="finances", version=__version__)
    web_dir = Path(__file__).parent / "web"
    app.mount(
        "/static",
        StaticFiles(directory=web_dir / "static"),
        name="static",
    )
    templates = Jinja2Templates(directory=str(web_dir / "templates"))

    def db():
        return connect(cfg)

    # ─────────────────────────  healthz  ─────────────────────────

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "version": __version__}

    # ─────────────────────────  transactions  ─────────────────────────

    @app.get("/api/transactions")
    def api_list_transactions(
        since: str = "30d",
        until: Optional[str] = None,
        account: Optional[str] = None,
        category: Optional[str] = None,
        merchant: Optional[str] = None,
        owner: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
        limit: int = 50,
    ):
        with db() as c:
            return q.list_transactions(
                c, since, until, account, category, merchant, owner,
                min_amount, max_amount, limit,
            )

    @app.get("/api/transactions/{tid}")
    def api_get_transaction(tid: int):
        with db() as c:
            r = q.get_transaction(c, tid)
        if not r:
            raise HTTPException(404, "not found")
        return r

    class Categorize(BaseModel):
        category: str
        create_rule: bool = False

    @app.post("/api/transactions/{tid}/categorize")
    def api_categorize(tid: int, body: Categorize):
        with db() as c:
            return q.categorize_transaction(c, tid, body.category, body.create_rule)

    class Annotate(BaseModel):
        note: str

    @app.post("/api/transactions/{tid}/note")
    def api_annotate(tid: int, body: Annotate):
        with db() as c:
            return q.annotate_transaction(c, tid, body.note)

    class ManualTxn(BaseModel):
        date: date
        amount: float
        merchant: str
        category: Optional[str] = None
        account: str
        owner: str = "household"
        note: Optional[str] = None

    @app.post("/api/transactions/manual")
    def api_add_manual(body: ManualTxn):
        with db() as c:
            tid = q.add_manual_transaction(
                c,
                date_=body.date,
                amount=body.amount,
                merchant=body.merchant,
                category=body.category,
                account=body.account,
                owner=body.owner,
                note=body.note,
            )
            return q.get_transaction(c, tid)

    # ─────────────────────────  spending + budgets  ─────────────────────────

    @app.get("/api/summary")
    def api_summary(
        since: str = "this-month",
        until: Optional[str] = None,
        group_by: str = "category",
        owner: Optional[str] = None,
    ):
        with db() as c:
            return q.summarize_spending(c, since, until, group_by, owner)

    @app.get("/api/budget/{month}")
    def api_budget(month: str, owner: str = "household"):
        with db() as c:
            return q.get_budget(c, month, owner).model_dump()

    # ─────────────────────────  bills  ─────────────────────────

    @app.get("/api/bills")
    def api_bills(within_days: int = 14, state: str = "any"):
        with db() as c:
            return q.upcoming_bills(c, within_days, state)

    class AddBill(BaseModel):
        payee: str
        amount: float
        due_date: date
        account: str
        recurrence: str = "one-off"
        autopay: bool = False

    @app.post("/api/bills")
    def api_add_bill(body: AddBill):
        with db() as c:
            bid = q.add_bill(
                c,
                payee=body.payee,
                amount=body.amount,
                due_date=body.due_date,
                account=body.account,
                recurrence=body.recurrence,
                autopay=body.autopay,
            )
        return {"id": bid}

    class BillState(BaseModel):
        state: str
        paid_amount: Optional[float] = None
        paid_date: Optional[date] = None

    @app.post("/api/bills/{bid}/state")
    def api_bill_state(bid: int, body: BillState):
        with db() as c:
            q.update_bill_state(c, bid, body.state, body.paid_amount, body.paid_date)
        return {"ok": True}

    # ─────────────────────────  accounts + categories  ─────────────────────────

    @app.get("/api/accounts")
    def api_accounts(active: bool = True):
        with db() as c:
            return q.list_accounts(c, active)

    @app.get("/api/categories")
    def api_categories():
        with db() as c:
            return q.list_categories(c)

    # ─────────────────────────  minimal web UI  ─────────────────────────

    @app.get("/", response_class=HTMLResponse)
    def home(request: Request):
        with db() as c:
            txns = q.list_transactions(c, since="30d", limit=25)
            summary = q.summarize_spending(c, since="this-month")
            bills = q.upcoming_bills(c, within_days=14)
        return templates.TemplateResponse(
            request,
            "index.html",
            {
                "version": __version__,
                "txns": txns,
                "summary": summary,
                "bills": bills,
            },
        )

    return app
