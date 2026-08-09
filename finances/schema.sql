-- finances v1 schema
-- SQLite; run via: uv run finances db init

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- short slug, e.g. chase-checking
  display_name TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('checking','savings','credit','cash','manual')),
  currency     TEXT NOT NULL DEFAULT 'USD',
  active       INTEGER NOT NULL DEFAULT 1,
  plaid_item_id     TEXT,
  plaid_account_id  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES categories(id),
  UNIQUE(name, parent_id)
);

CREATE TABLE IF NOT EXISTS merchants (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  display_name TEXT,
  default_category_id INTEGER REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY,
  external_id   TEXT UNIQUE,           -- Plaid txn id, hashed CSV row, etc.
  source        TEXT NOT NULL CHECK (source IN ('plaid','csv','manual','gmail')),
  date          TEXT NOT NULL,         -- ISO date
  amount        REAL NOT NULL,         -- negative = outflow
  currency      TEXT NOT NULL DEFAULT 'USD',
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  merchant_id   INTEGER REFERENCES merchants(id),
  merchant_raw  TEXT NOT NULL,         -- as it appeared in source, unmodified
  category_id   INTEGER REFERENCES categories(id),
  owner_id      INTEGER REFERENCES users(id),   -- NULL = household
  pending       INTEGER NOT NULL DEFAULT 0,
  ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_txn_date        ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_account     ON transactions(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_category    ON transactions(category_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_merchant    ON transactions(merchant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_owner_date  ON transactions(owner_id, date DESC);

CREATE TABLE IF NOT EXISTS transaction_notes (
  id             INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  note           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  id           INTEGER PRIMARY KEY,
  month        TEXT NOT NULL,          -- YYYY-MM
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  owner_id     INTEGER REFERENCES users(id),   -- NULL = household
  amount       REAL NOT NULL,
  UNIQUE(month, category_id, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_month ON budgets(month);

CREATE TABLE IF NOT EXISTS bills (
  id             INTEGER PRIMARY KEY,
  payee          TEXT NOT NULL,
  amount         REAL NOT NULL,        -- expected amount, positive
  due_date       TEXT NOT NULL,
  paid_date      TEXT,
  paid_amount    REAL,
  payment_account_id INTEGER REFERENCES accounts(id),
  recurrence     TEXT NOT NULL DEFAULT 'one-off' CHECK (recurrence IN ('one-off','monthly','quarterly','annual')),
  autopay        INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'upcoming' CHECK (state IN ('upcoming','paid','overdue','canceled')),
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','gmail')),
  source_ref     TEXT,                 -- e.g. Gmail message id
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bill_due ON bills(state, due_date);

CREATE TABLE IF NOT EXISTS rules (
  id                   INTEGER PRIMARY KEY,
  priority             INTEGER NOT NULL DEFAULT 100,   -- lower = higher priority
  merchant_regex       TEXT,                             -- match merchant_raw case-insensitive
  min_amount           REAL,
  max_amount           REAL,
  account_id           INTEGER REFERENCES accounts(id),
  set_category_id      INTEGER NOT NULL REFERENCES categories(id),
  set_owner_id         INTEGER REFERENCES users(id),
  note                 TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rule_priority ON rules(priority);

CREATE TABLE IF NOT EXISTS plaid_items (
  id                 INTEGER PRIMARY KEY,
  item_id            TEXT NOT NULL UNIQUE,
  institution_name   TEXT,
  cursor             TEXT,             -- Plaid /transactions/sync cursor
  linked_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at     TEXT
);
