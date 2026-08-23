# Operating Plan — Phase 0 to First Scale

This is the "how we actually run the company for the first 18 months"
document. It complements the technical spec by defining who we hire,
who we serve, how we deliver, what we measure, and the exit criteria
that move us from one phase to the next.

The thesis, restated in operating terms:

> **Deliver an exceptional Life Management service manually, with
> heavy instrumentation, then automate the workflows that
> demonstrably recur.**

Software follows demonstrated demand. We do not build agents for
categories of work no customer has asked for.

## Phase 0 — Concierge with instrumentation (Months 0–6)

**Goal.** 25 paying households receiving a service they would not
willingly give up. Every action captured in the console. A working
Life Graph per household. Zero customer-facing agents.

**Team.**

- 1 founder (product + customer relationships).
- 3 Life Managers (see hiring below).
- 1 engineer building the console and the graph.
- 1 designer (part-time).
- Fractional counsel, fractional finance, fractional security review.

**What we ship in software.**

- The manager console at the minimum quality where a manager can
  work a full day inside it.
- The Life Graph with the core ontology (people, orgs, places,
  assets, obligations, preferences, documents, actions).
- Ingest: calendar read, email read, document upload with OCR and
  classification, contact import.
- The action ledger and audit log.
- No customer surface beyond a simple SMS/email intake and a
  read-only status page.

**What we do not ship.**

- Any customer-facing chat with an agent.
- Any autonomous execution.
- A public marketing site beyond a single credible landing page.
- A mobile app.

**Customer intake cap.** Two new households per week, maximum. Below
capacity is fine; overshooting is not.

**Exit criteria to Phase 1.**

- 25 active households, ≥ 21 of them ≥ 60 days in service.
- Median customer NPS ≥ 60 (measured monthly).
- < 5% monthly logo churn.
- ≥ 300 actions per household per month in the ledger (evidence we
  are actually running their lives, not decorating).
- Top 20 recurring workflows identified and documented in the SOP
  library.
- Manager load ≤ 10 households each at steady state without weekend
  work.

If we hit month 6 without these, we do not build agents. We fix
service.

## Phase 1 — Assistive agents (Months 6–12)

**Goal.** Inbox and Calendar agents in Draft/Ask mode only, deployed
per-household behind a policy flag. Manager approves or edits every
outbound. Autonomous completion rate begins to climb on the specific
classes we chose to automate first.

**Team additions.**

- +2 Life Managers.
- +1 engineer (agent framework).
- +1 ML engineer (evals, router, model registry).
- +1 QA lead.

**What "chose to automate first" means.** The top 20 recurring
workflows from Phase 0 are ranked by:

1. **Volume** — how many minutes of manager time per week per
   household.
2. **Repeatability** — how many households experience it.
3. **Ceiling of automation** — how much of the workflow could be
   agent-safe vs. requires human judgment throughout.
4. **Blast radius on failure** — small, contained, reversible failures
   preferred first.

The first three we automate are almost certainly some combination of:
inbox triage and routing, appointment scheduling with known vendors,
and calendar reshuffles within the same day / same principal. Those
are the priors; the ranking dictates the truth.

**What we still do not ship.**

- Autonomous execution on financial or communication tools.
- A customer-facing chat with an agent.
- Households opting themselves into higher autonomy without manager
  co-sign.

**Exit criteria to Phase 2.**

- Autonomous-draft acceptance rate ≥ 70% on the top 3 automated
  workflows (manager sends without material edit).
- Manager edit distance trending down four weeks running.
- ≥ 40 active households.
- Manager load median 12 households; p95 15, both without weekend
  work.
- Zero policy-check false positives that reached a customer.
- Model tier for each automated task class is settled by data, not
  guess.

## Phase 2 — Executing agents (Months 12–18)

**Goal.** Selected classes of action promoted to Execute for
households whose policy permits it. Manager oversees post-hoc via the
console. Autonomous completion rate on the promoted classes ≥ 90%.
Customer-decisions-required per week begins to fall meaningfully.

**Team additions.**

- +3 Life Managers.
- +2 engineers.
- +1 ML engineer.
- +1 SRE.
- +1 head of operations (formalizes SOPs, QA cadence, load model).

**Promoted classes (initial candidates).**

- Restaurant reservations within customer policy.
- Same-day calendar changes under a threshold.
- Recurring household vendor scheduling with established vendors.
- Renewal detection with drafted forms for manager send.
- Low-value procurement within spend limits.

**Guardrails.**

- Every promoted class carries a **rollback plan** documented and
  rehearsed.
- Every promoted class carries a **suspension trigger** in the router
  (if quality degrades, class auto-demotes to Draft until reviewed).
- Every household is opted in per class, not en bloc.

**Exit criteria to Phase 3.**

- ≥ 75 active households.
- ≥ 5 action classes at Execute rung with < 1% rollback rate.
- Households-per-manager median ≥ 20.
- Autonomous completion rate (weighted across all classes) ≥ 40%.
- Customer-decisions-required per week median ≤ 5.

## First 25 customers — sourcing plan

**ICP for Phase 0.**

- Household income $500k+ or equivalent household complexity
  (multiple properties, dependents, business ownership, cross-border
  affairs).
- Time value clearly high; cognitive load clearly limiting.
- Currently pays for at least two of: EA, house manager, concierge,
  family organizer, or is doing that work themselves and resenting
  it.
- Within a two-hour flight of the founding manager team for the first
  cohort. This matters more than you'd expect for onboarding depth.
- Willing to be a design partner: monthly interview, weekly signal,
  patient with rough edges.

**Sourcing.**

- Founder-led warm intro from personal network. Do not attempt paid
  acquisition in Phase 0. It muddies the signal.
- 2–3 anchor customers who are known operators in their community
  (venture partners, senior lawyers, senior physicians) and will
  refer.
- Explicit "founding cohort" framing with a defined benefit
  (locked-in tier pricing, direct founder access, roadmap voice) in
  exchange for design-partnership commitment.

**Selection.** We turn people away. The wrong first customer is the
one who wants a magic AI that solves everything today. The right
first customer is the one who has already spent money trying to solve
this and hasn't.

## Hiring the first managers

This is the single most important recruiting decision the company
makes for the first 18 months. The Phase 0 managers set the standard
customers assume the company holds. Getting one wrong is expensive;
getting three wrong is fatal.

**Profile.**

- 7+ years in a role requiring judgment under ambiguity on behalf
  of a demanding principal — top-tier EA, private client work at a
  law/accounting firm, family office ops, luxury concierge, or the
  private-side of a top hotel.
- Comfortable with software; not required to be an engineer. Must
  believe technology should reduce their load, not threaten it.
- Written communication that is warm, calm, and precise.
- Track record of long relationships with demanding people.
- Ability to say "no, we don't do that" without losing the room.

**What we pay.** Above market for the equivalent EA role, with equity
meaningful to a career employee. This is not a call-center comp
structure and it should never become one.

**What we do not hire.** Junior operators to scale by headcount. That
is the traditional VA playbook and it is the thing we are trying not
to be.

**Sourcing.** Direct outreach to top-tier EA and private-client
communities. Referral bonus is meaningful. No agency recruiters in
the first cohort.

**Assessment.** A structured process:

1. Written scenario response (unbounded, take-home, 90 minutes) —
   assesses judgment, tone, structure.
2. Live scenario with a founder acting as a difficult customer —
   assesses composure and warmth.
3. Reference calls with two prior principals — the reference bar is
   *very* high; anything short of enthusiasm is disqualifying.
4. Culture conversation — does this person believe the customer's
   life is theirs to protect?

## Onboarding a customer (SOP outline)

Onboarding is the moment the graph is seeded and the relationship
is set. Anything skipped here costs 10× to recover later.

**Week 0 — Intro (founder or head of ops present).**
- Signed engagement, policies, and data authority.
- Manager introduction, in person if geographically possible.
- Set customer expectations: what we will do this month, what we
  won't do this month, what we'll ask for.

**Week 1 — Foundations.**
- Calendar and email read access.
- Household profile: principals, members, staff, key contacts.
- Property profile per home.
- Recurring obligations captured (school, vendor, professional,
  personal).
- Document intake: identity docs, insurance, memberships, key
  contracts.
- First-cut preferences (travel, dining, communication style).

**Week 2 — Policies.**
- Autonomy defaults reviewed and adjusted with the customer.
- Financial authority levels set and signed.
- Communication rules per recipient class.
- Sensitive-topic list confirmed.

**Week 3 — First running week.**
- Manager runs the customer's operational week alongside them.
- Every touch is captured; every decision the customer makes is
  a precedent for the graph.

**Week 4 — First review.**
- What worked, what didn't.
- What to add to the customer's brief for next month.
- Confirm the graph reflects reality.

**Month 3 — First quarterly.**
- Formal review with the customer.
- Autonomy adjustments.
- Renewal / expansion conversation if warranted.

## SOP library

Every recurring workflow has a written SOP, owned by the head of
operations, versioned in the same repo as the code:

- **Purpose.** What outcome this workflow produces.
- **Trigger.** What starts it.
- **Prereqs.** What must be in the graph before we can execute.
- **Steps.** Numbered, minimally ambiguous.
- **Decisions.** Where a manager judgment is required and what the
  defaults are.
- **Customer touchpoints.** Where the customer is informed or asked.
- **Failure modes.** What can go wrong and how to recover.
- **Metrics.** How we measure this workflow's success.
- **Automation candidacy.** T-shirt-size estimate of how much of
  this is automatable and at which model tier.

The SOP library is the source of truth for what the company knows how
to do. It is also the input to the automation ranking process.

## Instrumentation

Every action a manager takes in the console emits a structured event:

- Who, what, for which household, at what time.
- Which SOP it belongs to (or "ad hoc" if none).
- Which entities in the graph were touched.
- Time spent (start/end, active/passive).
- Manager annotation: was this straightforward, judgment, or firefighting?

This is the raw material for the automation ranking. Without it, we
are guessing.

Reviews:

- **Weekly ops review.** Head of ops + managers. What recurred? What
  broke? What surprised us? Which SOPs need revision?
- **Weekly product review.** Founder + engineering + ops. What is the
  next automation? What is the eval? What is the rollout plan?
- **Monthly customer review per household.** Manager + head of ops.
  What is this customer's trajectory? Are we saving them time? Are
  they using more of the service or less?

## Pricing (starting shape)

Three tiers, monthly, annual commitment for the founding cohort:

| Tier | Target customer | Monthly | Manager load weight |
| --- | --- | --- | --- |
| **Life** | Busy individual / small family | $499 | 1.0 |
| **Executive** | Executive + household | $999 | 1.8 |
| **Private** | Founder / HNW / private-office use | $2,500+ | 3.0+ |

Pricing rules:

- **No hourly billing, ever.** We sell coverage, not time.
- **No overage charges on manager time.** If a household is
  structurally over budget on manager time or inference, we have a
  tier conversation, not a nickel-and-dime conversation.
- **No launch discount.** The founding cohort is priced at full tier
  with rate lock, not a discount. We are not competing on price.
- **Explicit exclusions** documented in the engagement: what is not
  in scope at each tier (e.g., accounting-work-product, legal-work-
  product, medical decisions, driving/errands, physical staffing).

Financial coverage inside each tier (spend authorized on behalf of
the customer via delegated payment methods) is separate from
subscription price and governed by the policy engine.

## Financial model, sketch

Illustrative unit economics for a mid-Phase-2 steady state, per
Life-tier customer:

- Subscription revenue: $499 / month.
- Manager cost allocated: ~$180 / month (at 20 households per manager
  at $75k fully-loaded per month per manager including benefits and
  overhead — round numbers for illustration).
- Inference cost: ~$25 / month at the tiering and self-host mix in
  [`24-model-routing.md`](./24-model-routing.md).
- Third-party tooling per household: ~$15 / month.
- Gross contribution before shared overhead: ~$280 / month, ~55%.

The lever is not price. The lever is households-per-manager, and it
is only allowed to go up when the metrics in [`31-manager-console.md`](./31-manager-console.md)
say the service quality is holding.

Two things about this model to be honest about:

- Phase 0 unit economics are negative. Expected and correct.
- The Private tier subsidizes the fixed costs of the model until
  households-per-manager is proven. Weight the founding cohort
  toward that tier deliberately.

## Org shape at end of Phase 2

- Founder + head of ops + head of product.
- ~8–10 Life Managers.
- ~5–6 engineers.
- 1–2 ML engineers.
- 1 QA lead.
- 1 SRE.
- Fractional finance, counsel, security.

Roughly 20 people supporting ~75 households. That ratio is worse than
a mature ops looks like and better than a traditional EA operation
supporting the same customer complexity looks like. The number that
must move over the next 12 months is households-per-manager, not
headcount.

## Risks and how we intend to handle them

**Founding customer churn.** Kills the brand at this stage.
Mitigation: found ops-review culture; explicit save-motion when NPS
drops.

**Manager burnout.** Kills the service. Mitigation: hard load caps,
no weekend work as a policy, backup manager coverage, real PTO taken
by the founding team first.

**Automation quality regressions.** Kill customer trust silently.
Mitigation: replay-delta and edit-distance metrics; automatic
demotion of misbehaving task classes; QA sampling.

**A single security incident.** Kills the company. Mitigation: the
data model in [`23-data-model.md`](./23-data-model.md); a real security engineer engaged
before Phase 2; a rehearsed incident-response plan; encryption and
audit invariants that make the blast radius small even in a bad case.

**A single manager leaving with customers.** Mitigation: the
relationship is with the company, mediated by named managers.
Non-solicit as a matter of course. But the durable answer is that a
manager can't take the graph, and the graph is the reason the service
is what it is.

**AI-vendor policy change.** Mitigation: model tiering and
vendor-independence checklist in [`24-model-routing.md`](./24-model-routing.md).

**"AI" positioning creep.** Kills the brand. Mitigation: brand
guidelines that treat "AI assistant" language as forbidden externally,
even if it would help conversion in the short run. This is a
long-game category-creation bet.

## What Phase 3 looks like (preview, not a plan)

Proactive orchestration across domains. The "London for two weeks in
October" experience. This gets its own operating plan later, but the
gating question is simple: do the individual domain automations from
Phases 1–2 hold up under the additional load of cross-domain
coordination? We won't know until we're there.

The North Star holds: **Life, managed.** Everything in this document
is in service of getting to a world where a customer can say that
sentence about their life and mean it.
