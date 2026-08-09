# MCP tools

The typed tool surface May calls. All tools are read-mostly; write
tools are limited to metadata (categorization, notes, bill state) —
nothing that moves money.

## Read tools

### `list_transactions`

```
list_transactions(
  since: iso-date | "30d" | "this-month" | "last-month",
  until: iso-date | null = null,
  account: string | null = null,
  category: string | null = null,     # matches on category or any child
  merchant: string | null = null,     # substring, case-insensitive
  owner: "peter" | "shweta" | "household" | null = null,
  min_amount: number | null = null,
  max_amount: number | null = null,
  limit: int = 50,
) → Transaction[]
```

### `get_transaction`

```
get_transaction(id: int) → Transaction
```

### `summarize_spending`

```
summarize_spending(
  since: iso-date | "30d" | "this-month" | "last-month",
  until: iso-date | null = null,
  group_by: "category" | "merchant" | "account" | "owner" = "category",
  owner: "peter" | "shweta" | "household" | null = null,
) → { key: string, total: number, count: int }[]
```

### `get_budget`

```
get_budget(
  month: iso-month = <current>,
  owner: "peter" | "shweta" | "household" = "household",
) → {
  month,
  owner,
  lines: {
    category, budgeted, actual, remaining,
    pct_used, over_budget: bool
  }[],
  totals: { budgeted, actual, remaining }
}
```

### `upcoming_bills`

```
upcoming_bills(
  within_days: int = 14,
  state: "upcoming" | "overdue" | "any" = "any",
) → Bill[]
```

### `list_accounts`

```
list_accounts(active: bool = true) → Account[]
```

### `list_categories`

```
list_categories() → Category[]     # includes tree structure
```

## Write tools (metadata only)

### `categorize_transaction`

```
categorize_transaction(
  transaction_id: int,
  category: string,               # by name or id
  create_rule: bool = false,      # if true, also creates a rule so
                                  # future matching txns auto-categorize
) → { ok: bool, rule_created: bool }
```

### `annotate_transaction`

```
annotate_transaction(
  transaction_id: int,
  note: string,
) → { ok: bool }
```

### `add_manual_transaction`

```
add_manual_transaction(
  date: iso-date,
  amount: number,                 # negative = money out
  merchant: string,
  category: string | null = null,
  account: string,
  owner: "peter" | "shweta" | "household" = "household",
  note: string | null = null,
) → Transaction
```

### `update_bill_state`

```
update_bill_state(
  bill_id: int,
  state: "paid" | "canceled",
  paid_amount: number | null = null,
  paid_date: iso-date | null = null,
) → Bill
```

### `add_bill`

```
add_bill(
  payee: string,
  amount: number,                 # positive
  due_date: iso-date,
  account: string,                # payment account
  recurrence: "one-off" | "monthly" | "quarterly" | "annual" = "one-off",
  autopay: bool = false,
) → Bill
```

## Types

```
Transaction {
  id: int,
  date: iso-date,
  amount: number,                 # negative = money out (spend)
  merchant: string,
  category: string,
  account: string,
  owner: "peter" | "shweta" | "household",
  source: "plaid" | "csv" | "manual" | "gmail",
  note: string | null,
}

Bill {
  id: int,
  payee: string,
  amount: number,
  due_date: iso-date,
  paid_date: iso-date | null,
  paid_amount: number | null,
  account: string,                # payment account
  recurrence: "one-off" | "monthly" | "quarterly" | "annual",
  autopay: bool,
  state: "upcoming" | "paid" | "overdue" | "canceled",
}

Account {
  id: int,
  name: string,                   # short name, e.g. "chase-checking"
  display_name: string,
  type: "checking" | "savings" | "credit" | "cash" | "manual",
  active: bool,
}

Category {
  id: int,
  name: string,
  parent_id: int | null,
  full_path: string,              # e.g. "Food & Household / Groceries"
}
```

## What's deliberately not here

- `pay_bill`, `transfer`, `move_money` — anything that moves cash. That
  belongs to the money-agent (Layer 3), which is a separate service
  behind its own MCP boundary. This app is the observability layer.
- `delete_transaction` — transactions are immutable. To reverse, use
  `add_manual_transaction` with an opposite amount.
- `edit_transaction_amount` — same rule; add a reversal + corrected
  entry.
- Any tool that can widen credentials or reach outside 127.0.0.1.
