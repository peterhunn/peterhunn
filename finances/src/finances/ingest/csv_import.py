"""CSV importer with auto-detection for common bank export shapes.

Handles: generic (date, amount, description), Chase, Amex.
Add a parser for a new provider by extending PARSERS below.
"""

from __future__ import annotations

import csv
import hashlib
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Callable

from .normalize import RawTxn, ingest


ParseRow = Callable[[dict[str, str]], RawTxn | None]


def _row_hash(row: dict[str, str], account: str) -> str:
    key = "|".join([account, *(f"{k}={v}" for k, v in sorted(row.items()))])
    return hashlib.sha256(key.encode()).hexdigest()[:32]


def _parse_generic(row: dict[str, str], account: str) -> RawTxn | None:
    """Any CSV with 'date', 'amount', 'description' columns (case-insensitive)."""
    lower = {k.lower().strip(): v for k, v in row.items()}
    if not {"date", "amount", "description"}.issubset(lower):
        return None
    try:
        d = _to_date(lower["date"])
        amt = float(lower["amount"].replace(",", "").replace("$", "").replace("£", "").strip())
    except (ValueError, KeyError):
        return None
    return RawTxn(
        external_id=_row_hash(row, account),
        source="csv",
        date=d,
        amount=amt,
        account_name=account,
        merchant_raw=lower["description"].strip(),
    )


def _parse_chase(row: dict[str, str], account: str) -> RawTxn | None:
    # Chase: 'Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount'
    if "Transaction Date" not in row or "Amount" not in row:
        return None
    try:
        d = _to_date(row["Transaction Date"])
        amt = float(row["Amount"])
    except ValueError:
        return None
    return RawTxn(
        external_id=_row_hash(row, account),
        source="csv",
        date=d,
        amount=amt,
        account_name=account,
        merchant_raw=(row.get("Description") or "").strip(),
    )


def _parse_amex(row: dict[str, str], account: str) -> RawTxn | None:
    # Amex: 'Date', 'Description', 'Amount' (positive = charge on Amex, invert)
    if "Description" not in row or "Amount" not in row or "Date" not in row:
        return None
    try:
        d = _to_date(row["Date"])
        amt = -float(row["Amount"])   # Amex convention: positive = spend
    except ValueError:
        return None
    return RawTxn(
        external_id=_row_hash(row, account),
        source="csv",
        date=d,
        amount=amt,
        account_name=account,
        merchant_raw=row["Description"].strip(),
    )


PARSERS: dict[str, Callable[[dict[str, str], str], RawTxn | None]] = {
    "chase":   _parse_chase,
    "amex":    _parse_amex,
    "generic": _parse_generic,
}


def _to_date(s: str) -> date:
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%m-%d-%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            continue
    raise ValueError(f"could not parse date: {s!r}")


def import_csv(
    conn: sqlite3.Connection,
    path: Path,
    account: str,
    provider: str = "generic",
) -> dict:
    parser = PARSERS.get(provider.lower())
    if parser is None:
        raise ValueError(
            f"unknown provider: {provider!r}. Known: {sorted(PARSERS)}"
        )
    txns: list[RawTxn] = []
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            t = parser(row, account)
            if t:
                txns.append(t)
    return ingest(conn, txns)
