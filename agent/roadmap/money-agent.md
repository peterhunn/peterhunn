# Money agent

May observes, drafts, and (eventually, within tight caps) executes
transactions on the Hunn family's behalf. Bills, groceries,
subscriptions, refunds.

## Why not now

- Base May must have run stably for ≥ 4 weeks
- CONSENT.md needs a money-actions rider signed by both Peter and Shweta
- Plaid account created (read-only tier, free for personal use)
- A dedicated Telegram bot for money confirmations — **not** the general
  `me`/`shweta` channels. Compromise of the general channel must not
  become a compromise of the spending loop.

## Layers of maturity

### Layer 1 — Passive (safe, high value, build first)

May watches money move but never touches it.

- **Bill tracking**: scan `office@`, `peter@`, `shweta@` for incoming
  bills → extract amount + due date → log to a Sheet on
  `office@`'s Drive → alert 3 days before due
- **Auto-pay verification**: confirm mortgage / utility / phone bill
  actually drafted this month, ping if it didn't
- **Subscription audit**: read bank + card statements via Plaid → flag
  recurring charges nobody uses ("still paying $17/mo for that gym
  nobody goes to")
- **Unusual charge alerts**: same Plaid feed → ping if a charge is
  > 2× the merchant's rolling average
- **Weekly cost report**: end-of-week summary to the money channel —
  categorized spending, delta vs prior week, upcoming bills

Risk: near-zero. Value: significant. Zero irreversible actions.

### Layer 2 — Assisted (medium, build second)

May drafts transactions; a human taps Buy.

- **Grocery order draft**: assemble list from Obsidian meal plan +
  staples reorder cadence + family additions → populate the
  Instacart/Whole Foods/Amazon Fresh cart via browser automation →
  DM a "review + tap Buy" link to the money channel
- **Payment portal drafts**: for anything not on auto-pay, May fills
  the biller's portal form and stops at Submit — human confirms
- **Refund / cancellation drafts**: writes the "please cancel" email
  or fills the merchant's cancellation form → sends to the money
  channel for approval
- **Reimbursement drafts**: extracts expense receipts from mail →
  populates the reimbursement form → human submits

Risk: low (human always taps). Works with almost any merchant since
the automation is a browser session, not an API.

### Layer 3 — Autonomous within tight caps (real thought required)

May actually spends without per-transaction approval, within
pre-negotiated rules.

- **Auto-reorder consumables**: coffee, paper towels, specific pantry
  staples. Only from a whitelisted merchant. Only under `$X` per order.
  Only up to `$Y` per month per category.
- **Auto-confirm recurring bills**: mortgage, utility, phone auto-pay
  confirmations under the expected amount. Auto-flag (not auto-approve)
  if 20%+ over expected.
- **Set-and-forget subscriptions**: Netflix, iCloud, etc. May confirms
  the renewal landed at the expected amount.

Never in Layer 3:

- New payees
- Wire transfers
- Payments abroad
- Anything the system flags as anomalous
- Card details / bank account changes
- Any single transaction > `$X` (default $200)

## Architecture

Money-touching operations live behind a **dedicated finance agent** (its
own MCP server), not smeared into May's general tool set.

```
you (money-Telegram)
  ↔ May (Gemma 4)
      → finance-agent (MCP): propose_purchase(...) → signed proposal id
      ↔ you (money-Telegram): "Buy $47 groceries at Whole Foods, confirm?"
      ↔ you: "yes"
      → finance-agent: execute_purchase(proposalId, confirmationToken)
      ← finance-agent: signed receipt, appended to immutable audit log
```

Reasons for the split:

1. **Scope isolation** — the finance agent has narrow, auditable
   capabilities. May calls it; May does not become it.
2. **Hard caps enforced in the agent, not in prompts** — per-transaction
   limit, per-day limit, per-merchant whitelist, geographic whitelist.
   Model can propose anything; agent refuses out-of-policy.
3. **Two-call design** — `propose_purchase` returns a signed proposal
   id; `execute_purchase` requires that id + a fresh user confirmation
   from the money channel.
4. **Immutable audit log** — appended to a file the finance agent owns,
   May cannot edit. Rotation, not truncation.
5. **Dedicated confirmation channel** — separate Telegram bot,
   2FA-protected on a dedicated account, minimal contact list.

## Concrete tools + APIs

| Purpose | Tool | Notes |
|---|---|---|
| Read transactions | [Plaid](https://plaid.com) | Free personal tier, read-only |
| Grocery ordering | Instacart Connect / browser automation | Consumer API is limited; expect Playwright |
| Bill portals | Playwright | Fragile, expect maintenance |
| Bank auto-pay verification | Plaid + email confirmations | Cross-check |
| Reimbursement | Gmail + merchant portal | Manual submit |
| Audit log | Local append-only file + optional S3 mirror | Not in OpenClaw memory |

## Manual steps (can't be scripted)

- Sign the money-actions rider on CONSENT.md
- Create Plaid developer account, link Peter's + Shweta's + office@'s
  primary accounts
- Set up dedicated Telegram bot + Apple ID for money confirmations
- Enable 2FA everywhere the money channel touches
- Whitelist merchants + set caps in the finance agent's config
- Notify each card issuer that automated transactions may occur (some
  banks require this to prevent fraud freezes)

## When it fails

| Failure | Recovery |
|---|---|
| Card declines from fraud detection | Expected first month; call issuer, mark merchant as trusted |
| Merchant site changes layout, Playwright breaks | Falls back to draft-only, notifies you; fix the selector |
| Wrong amount confirmed by model | Two-call design + human confirmation blocks this; audit log identifies who approved |
| Plaid link expires | 90-day re-auth is a manual browser click, unavoidable |
| Runaway loop (agent tries to buy same thing 50x) | Rate limits enforced in finance agent (per-recipient, per-day, per-category) |

## Order of operations, when we build

1. Sign the CONSENT.md rider
2. Layer 1 in full — build for one month, catch every bill and subscription
3. Layer 2 for groceries only — one merchant, one cart, human always taps
4. Expand Layer 2 to bill portals
5. Layer 3 for **one** category (paper towels via Amazon Subscribe & Save is
   a reasonable first target — small, boring, easy to cap)
6. Expand Layer 3 slowly, one category at a time, review audit log weekly

**Never all at once. Never before base is proven.**
