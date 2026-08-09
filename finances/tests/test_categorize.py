from finances.categorize import categorize, load_rules
from finances.ingest.normalize import RawTxn, ingest, upsert_account


def test_rules_load_and_match(db):
    rules = load_rules(db)
    assert any(r.merchant_regex == "whole foods" for r in rules)
    acct = upsert_account(db, "test-checking")
    cat_id, _ = categorize(rules, "WHOLE FOODS MARKET", -85.20, acct)
    assert cat_id is not None
    cat = db.execute("SELECT name FROM categories WHERE id = ?", (cat_id,)).fetchone()
    assert cat["name"] == "Groceries"


def test_fallback_to_needs_review(db):
    rules = load_rules(db)
    acct = upsert_account(db, "test-checking")
    cat_id, _ = categorize(rules, "SOME OBSCURE MERCHANT", -20.0, acct)
    cat = db.execute("SELECT name FROM categories WHERE id = ?", (cat_id,)).fetchone()
    assert cat["name"] == "Needs review"


def test_ingest_is_idempotent(db):
    from datetime import date
    t = RawTxn(
        external_id="abc-123",
        source="csv",
        date=date(2026, 7, 1),
        amount=-42.0,
        account_name="test-checking",
        merchant_raw="Whole Foods Market",
    )
    r1 = ingest(db, [t])
    r2 = ingest(db, [t])
    assert r1["inserted"] == 1
    assert r2["inserted"] == 0
    assert r2["skipped_duplicate"] == 1
