"""Pydantic types shared across REST + MCP."""

from __future__ import annotations

from datetime import date
from typing import Literal, Optional

from pydantic import BaseModel, Field


Owner = Literal["peter", "shweta", "household"]
Source = Literal["plaid", "csv", "manual", "gmail"]
AccountType = Literal["checking", "savings", "credit", "cash", "manual"]
BillState = Literal["upcoming", "paid", "overdue", "canceled"]
Recurrence = Literal["one-off", "monthly", "quarterly", "annual"]


class Transaction(BaseModel):
    id: int
    date: date
    amount: float
    merchant: str
    category: Optional[str]
    account: str
    owner: Owner
    source: Source
    note: Optional[str] = None
    pending: bool = False


class BudgetLine(BaseModel):
    category: str
    budgeted: float
    actual: float
    remaining: float
    pct_used: float
    over_budget: bool


class BudgetTotals(BaseModel):
    budgeted: float
    actual: float
    remaining: float


class Budget(BaseModel):
    month: str  # YYYY-MM
    owner: Owner
    lines: list[BudgetLine]
    totals: BudgetTotals


class Bill(BaseModel):
    id: int
    payee: str
    amount: float
    due_date: date
    paid_date: Optional[date] = None
    paid_amount: Optional[float] = None
    account: Optional[str] = None
    recurrence: Recurrence = "one-off"
    autopay: bool = False
    state: BillState = "upcoming"


class Account(BaseModel):
    id: int
    name: str
    display_name: str
    type: AccountType
    active: bool = True


class Category(BaseModel):
    id: int
    name: str
    parent_id: Optional[int] = None
    full_path: str


class SpendGroup(BaseModel):
    key: str
    total: float
    count: int


class AddManualTransactionInput(BaseModel):
    date: date
    amount: float
    merchant: str
    category: Optional[str] = None
    account: str
    owner: Owner = "household"
    note: Optional[str] = None


class AddBillInput(BaseModel):
    payee: str
    amount: float = Field(gt=0)
    due_date: date
    account: str
    recurrence: Recurrence = "one-off"
    autopay: bool = False
