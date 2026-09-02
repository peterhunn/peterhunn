# Business model

The commercial shape of ATELIER — who pays, for what, how much,
and what makes it defensible.

Adjacent reading:
[`00-overview.md`](./00-overview.md) for the product thesis,
[`10-operating-plan.md`](./10-operating-plan.md) for phased
execution, [`31-manager-console.md`](./31-manager-console.md)
for how a manager actually spends the hours we sell.

## The offer

ATELIER sells one thing: **a named human Life Manager, backed by
a Life Graph and a fleet of software agents, who runs your
household so you don't.** The customer talks to a person. That
person is amplified by software the customer never sees.

We are not selling AI, and we are not selling access to a chat
surface. We are selling coverage of an outcome — the mundane,
recurring operational load of running a life.

Three deliberate consequences of the framing:

- **The customer never debugs the software.** If an agent
  misfires, the manager cleans it up before it reaches the
  customer. The customer's experience is "asked for a thing,
  got the thing."
- **The manager scales with software, not without it.** A
  Phase-0 manager runs 3–5 households; the Phase-3 target is
  20–30. That's the entire economic engine.
- **The graph is the moat.** Every touch a manager takes with
  a household teaches the graph — the customer's people,
  vendors, preferences, obligations. A competitor starting
  from zero on that household would need years to catch up.

## Tiers

Three tiers, monthly, annual commitment for the founding cohort.
Numbers are the starting shape; the actual price sheet lives in
the sales collateral and moves independently of this doc.

| Tier          | Target customer                             | Monthly    | Manager-load weight |
| ------------- | ------------------------------------------- | ---------- | ------------------- |
| **Life**      | Busy individual / small family              | ~$499      | 1.0                 |
| **Executive** | Executive + household                       | ~$999      | 1.8                 |
| **Private**   | Founder / HNW / private-office use          | ~$2,500+   | 3.0+                |

The **manager-load weight** is how many "standard households" a
tier consumes from a manager's capacity. A manager targeting 20
weighted households can carry, e.g., 10 Executive + a Private
(1.8 × 10 + 3 = 21). This is the scheduling primitive the
console uses when routing intake to available managers.

## Pricing rules

Non-negotiable:

- **No hourly billing, ever.** We sell coverage. Hours are our
  problem, not the customer's.
- **No overage charges on manager time.** If a household is
  structurally over budget on manager time or inference spend,
  it's a tier conversation, not a nickel-and-dime one.
- **No launch discount.** The founding cohort is priced at full
  tier with rate-lock for renewal, not a discount. We are not
  competing on price.
- **Explicit exclusions** documented in every engagement: what
  is *not* in scope at each tier (e.g. accounting-work-product,
  legal-work-product, medical decisions, driving / errands,
  physical staffing). Draws the line early so the manager isn't
  saying no in the middle of a bad week.

## Inference budgets

Every tier has an implicit inference-spend cap, currently:

| Tier          | Monthly LLM budget (USD) |
| ------------- | ------------------------ |
| **Life**      | $25                      |
| **Executive** | $60                      |
| **Private**   | $150                     |

Enforced by the router: at 80% of the cap the console badges
"approaching budget"; over the cap the router demotes to the
declared minimum tier for each task class; over `cap × 1.5`
(`ATELIER_BUDGET_HARD_MULTIPLE`, default 1.5) `callModel` throws
`BudgetExceededError` — a runaway agent can't drain the account.

Numbers live in `apps/api/src/runtime.ts` (`MONTHLY_INFERENCE_BUDGET_USD`)
and can be tuned per-tier without a schema change.

## Unit economics (working model)

At steady state, the target contribution shape per manager:

| Line                                    | Life        | Executive   | Private     |
| --------------------------------------- | ----------- | ----------- | ----------- |
| Household MRR                           | ~$499       | ~$999       | ~$2,500+    |
| LLM cost cap (hard limit)               | ~$37        | ~$90        | ~$225       |
| Manager cost per household (allocated)  | (see below) | (see below) | (see below) |

**Manager cost** is the biggest line. Assume a fully-loaded
manager cost of ~$180K/year (US metro, top-tier EA-caliber). A
manager carrying 20 weighted households allocates ~$9K/year per
weighted unit. On a Life household (weight 1.0), that's ~$750/mo
of manager cost against ~$499 of revenue — negative contribution.

That's not a bug; that's why Phase 0 is a subsidised founding
cohort. Positive contribution shows up once:

1. **Agents lift the manager-per-household ceiling.** Phase-2
   automation targets 40 weighted households / manager. At that
   ratio Life households turn positive.
2. **Tier mix shifts toward Executive / Private.** Executive at
   1.8 weight × 20 = 36 units gives one manager 10 households at
   $10K MRR / month vs $9K allocated cost — contribution positive
   with room for LLM cost and infrastructure.

The commercial goal is therefore to (a) start Executive-heavy,
(b) ship enough automation in Phase 2 that Life becomes viable,
and (c) never subsidize outside the founding cohort.

## Revenue model

- **Subscription** — the only revenue line. Monthly, annual
  commit. No usage fees, no per-action markup, no add-ons.
- **No commissions from vendors.** We don't take a cut from a
  travel agent, a moving company, or a caterer we book on the
  customer's behalf. Ever. Alignment matters more than the
  optional revenue line.
- **No data sale, no ads.** The customer's graph is theirs;
  we're the operator, not the beneficiary of its contents.

Exclusions we may charge separately in the future (currently
priced-in / declined):

- One-time onboarding fee for households with unusually messy
  initial state (multiple homes, complex documents, no digital
  hygiene). Priced in engineering hours + manager hours; decided
  case-by-case in the founding cohort.
- Physical services (a driver, a chef, an errand-runner). These
  are always via the customer's own payment relationship with
  the vendor; ATELIER doesn't intermediate the money.

## Defensibility

Three interlocking moats, ordered by how quickly they compound:

1. **The graph.** Every touch teaches. A competitor entering a
   household with a two-year graph is starting from a two-year
   information disadvantage. This is the fastest-compounding
   asset and the reason "concierge first, automation second" is
   the sequence, not the other way around.
2. **The manager relationship.** People stay with people. A
   manager who has run a household for a year has trust that
   isn't transferable. Manager retention is therefore an equal
   priority to customer retention.
3. **The autonomy ladder.** As policy fills in per household,
   the fraction of actions that require zero human touch grows.
   That's the mechanism that eventually converts Life-tier
   households from negative to positive contribution.

The moat we deliberately don't rely on:
- **Model quality.** We route across providers and self-host
  what we can. The system doesn't get materially better because
  we bet the right way on a frontier lab. (See
  [`24-model-routing.md`](./24-model-routing.md).)
- **Distribution.** The founding cohort is direct outreach and
  referral. Once contribution is positive there's a real growth
  motion; before then, growth is a distraction.

## What this is NOT

- **Not a chatbot.** Customers reach a person. The AI is
  behind the person, not in front.
- **Not a marketplace.** We don't broker between customers and
  vendors, take a cut, or run auctions. Every vendor engagement
  is on the customer's account, on the customer's terms.
- **Not a productivity tool.** No calendars for you to look at,
  no dashboards, no notifications. If you're logging in, we're
  failing.
- **Not enterprise.** The buyer is a person or a family. If a
  family office wants to buy for their principal, fine; that's
  still a single household.
