"""SQLite connection + schema init + category loading."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from importlib import resources
from pathlib import Path
from typing import Iterator

import yaml

from .config import Config


SCHEMA_RESOURCE = "schema.sql"


def _schema_sql() -> str:
    # schema.sql lives at repo root; when installed as a package we still
    # ship it via package data (see pyproject wheel packages). Try both.
    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / "schema.sql",           # editable install
        here.parent / "schema.sql",               # bundled copy
    ]
    for c in candidates:
        if c.exists():
            return c.read_text()
    raise FileNotFoundError("schema.sql not found next to source or in package")


def connect(cfg: Config) -> sqlite3.Connection:
    conn = sqlite3.connect(cfg.db_path, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def init_db(cfg: Config) -> None:
    """Create schema and seed users + categories + rules."""
    conn = connect(cfg)
    conn.executescript(_schema_sql())
    _seed_users(conn, cfg)
    _load_categories_yaml(conn, cfg)


def _seed_users(conn: sqlite3.Connection, cfg: Config) -> None:
    for u in cfg.users:
        conn.execute(
            "INSERT OR IGNORE INTO users (name, display_name) VALUES (?, ?)",
            (u.name, u.display_name),
        )


def _load_categories_yaml(conn: sqlite3.Connection, cfg: Config) -> None:
    if not cfg.categories_file.exists():
        return
    data = yaml.safe_load(cfg.categories_file.read_text())

    # Categories tree
    for top in data.get("categories", []):
        # each entry is either a string (leaf under root) or a single-key
        # dict {parent: [children...]}
        if isinstance(top, str):
            _upsert_category(conn, top, parent_id=None)
        elif isinstance(top, dict):
            for parent, children in top.items():
                pid = _upsert_category(conn, parent, parent_id=None)
                for child in children or []:
                    _upsert_category(conn, child, parent_id=pid)

    # Rules
    conn.execute("DELETE FROM rules")   # rules are authoritative from yaml
    for r in data.get("rules", []):
        m = r.get("match") or {}
        s = r.get("set") or {}
        cat_name = s.get("category")
        if not cat_name:
            continue
        cat_id = _find_category_by_leaf_name(conn, cat_name)
        if cat_id is None:
            continue
        conn.execute(
            """
            INSERT INTO rules
              (priority, merchant_regex, min_amount, max_amount, set_category_id, note)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                int(r.get("priority", 100)),
                m.get("merchant"),
                m.get("min_amount"),
                m.get("max_amount"),
                cat_id,
                s.get("note"),
            ),
        )


def _upsert_category(conn: sqlite3.Connection, name: str, parent_id: int | None) -> int:
    cur = conn.execute(
        "SELECT id FROM categories WHERE name = ? AND (parent_id IS ? OR parent_id = ?)",
        (name, parent_id, parent_id),
    )
    row = cur.fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO categories (name, parent_id) VALUES (?, ?)",
        (name, parent_id),
    )
    return cur.lastrowid


def _find_category_by_leaf_name(conn: sqlite3.Connection, name: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM categories WHERE name = ?",
        (name,),
    ).fetchone()
    return row["id"] if row else None
