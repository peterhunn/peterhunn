from datetime import date

from finances import queries as q
from finances.ingest.csv_import import import_csv


def _load_sample(db, tmp_path):
    csv_path = tmp_path / "sample.csv"
    csv_path.write_text(
        "date,amount,description\n"
        "2026-07-01,-100.00,WHOLE FOODS MARKET\n"
        "2026-07-01,-5.00,STARBUCKS #14832\n"
        "2026-07-02,-40.00,SHELL 12994\n"
        "2026-07-02,-80.00,WHOLE FOODS MARKET\n"
        "2026-07-05,3000.00,ACME PAYROLL\n"
    )
    return import_csv(db, csv_path, account="chase-checking", provider="generic")


def test_list_and_summarize(db, tmp_path):
    _load_sample(db, tmp_path)
    txns = q.list_transactions(db, since="2026-07-01", until="2026-07-06")
    assert len(txns) == 5
    grp = q.summarize_spending(db, since="2026-07-01", until="2026-07-06")
    by_cat = {g["key"]: g["total"] for g in grp}
    assert by_cat.get("Groceries") == 180.0
    assert by_cat.get("Coffee") == 5.0
    assert by_cat.get("Fuel") == 40.0
    # Income (positive) is not counted as spend
    assert "Needs review" not in by_cat or by_cat["Needs review"] == 0


def test_budget_lines_math(db, tmp_path):
    _load_sample(db, tmp_path)
    # set a $200 groceries budget for the household in July 2026
    db.execute(
        "INSERT INTO budgets (month, category_id, owner_id, amount) "
        "VALUES ('2026-07', (SELECT id FROM categories WHERE name='Groceries'), NULL, 200.0)"
    )
    b = q.get_budget(db, "2026-07", owner="household")
    groc = [ln for ln in b.lines if ln.category == "Groceries"][0]
    assert groc.budgeted == 200.0
    assert groc.actual == 180.0
    assert groc.remaining == 20.0
    assert not groc.over_budget


def test_bills_upcoming(db):
    from finances.ingest.normalize import upsert_account
    acct = upsert_account(db, "chase-checking")
    _ = acct
    q.add_bill(
        db,
        payee="Comed Electric",
        amount=112.40,
        due_date=date.today(),
        account="chase-checking",
        recurrence="monthly",
        autopay=True,
    )
    upcoming = q.upcoming_bills(db, within_days=14)
    assert len(upcoming) == 1
    assert upcoming[0]["payee"] == "Comed Electric"
