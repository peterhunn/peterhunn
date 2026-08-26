# Life Graph

The Life Graph is the household's persistent, permissioned model of
their life. It is the strategic asset: every completed action writes
back to it, and every future action reads from it.

## Design commitments

1. **Household-scoped tenancy.** One graph per household. No shared
   entities across households, ever. Vendor "Acme HVAC" in household A
   is a distinct node from "Acme HVAC" in household B, even if they
   describe the same real-world company.
2. **Entities and relationships are first-class.** Not a note store
   with tags. An HVAC service on a specific property performed by a
   specific vendor on a specific date is one fact; the entities and
   the relationship both exist independently and are queryable.
3. **Provenance is required.** Every fact carries who/what asserted
   it, when, and from which source. Facts without provenance cannot
   enter the graph.
4. **Confidence is required.** Every fact carries a confidence score
   and a status: `candidate`, `confirmed`, `retired`. Agents write
   `candidate`; managers or repeated confirmation promote to
   `confirmed`; contradictory evidence retires.
5. **Policies live in the graph.** Authority (see [`33-permissions-and-autonomy.md`](./33-permissions-and-autonomy.md))
   is a set of nodes and edges, not application config. This is what
   lets the same authorization engine run for every household.
6. **The graph is portable.** Everything a household has entered or
   the system has learned about them is exportable in a documented
   schema. If a customer leaves, they get their graph.

## Core entity types

Types are namespaced. The core types below are stable; new types are
added by extending the ontology, not by overloading existing types.

### People
- `person.principal` — a decision-authority person in the household.
- `person.member` — non-principal household member (child, dependent).
- `person.staff` — household staff (nanny, house manager, driver).
- `person.contact` — anyone outside the household who matters:
  colleagues, teachers, doctors, extended family, vendors' individuals.

### Organizations
- `org.employer`
- `org.school`
- `org.provider.medical`
- `org.provider.financial`
- `org.provider.insurance`
- `org.club`
- `org.airline` / `org.hotel_group` / `org.rental`
- `org.vendor` — trades, services, contractors, retailers.

### Places
- `place.property` — a residence, second home, office, storage.
- `place.address` — any addressable location that isn't a property
  (a school campus, a doctor's office).

### Assets
- `asset.vehicle`
- `asset.equipment` (HVAC unit, boiler, generator, appliance)
- `asset.membership` (club, gym, airline status)
- `asset.account` (bank, brokerage, loyalty) — see privacy notes
- `asset.pet`
- `asset.collection` (art, wine, etc — used only where relevant)

### Obligations
- `obligation.appointment`
- `obligation.deadline` (school form, tax filing, renewal)
- `obligation.recurring` (weekly PT, monthly boiler service)
- `obligation.event` (birthday, anniversary, milestone)
- `obligation.bill`

### Preferences
- `preference.travel` (airline, seat, hotel brand, room type)
- `preference.dining` (dietary, favored restaurants, meeting spots)
- `preference.communication` (channel, timing, formality)
- `preference.vendor` (preferred plumber, cleaner, etc.)
- `preference.decision` (approval thresholds, veto rules)

### Documents
- `document.identity` (passport, ID, license) — also the **placeholder
  bucket** on upload. When the console lets a manager attach a file
  without picking a subcategory, the node lands here and the upload
  route auto-recategorises to `document.receipt` / `.legal` /
  `.policy` / `.record` if the inline document extractor
  (Anthropic vision on images, pdf-parse + text on PDFs) returns a
  confident `category` field. Mock/fallback extractions never
  auto-move — no signal means no move. A node the manager
  explicitly created outside `document.identity` is treated as
  pinned and never overruled, even if the extractor disagrees.
- `document.legal` (contract, will, POA)
- `document.policy` (insurance)
- `document.record` (medical, school, tax)
- `document.receipt`

### Actions and history
- `action` — every action taken by the system, past or planned.
- `interaction` — every meaningful customer/manager conversation.
- `decision` — a customer choice that establishes precedent.

### Authority
- `policy` — a stored authorization rule (see [`33-permissions-and-autonomy.md`](./33-permissions-and-autonomy.md)).
- `permission` — a granted access to an external system.

## Core relationship types

Relationships are typed edges with attributes. A partial catalog:

```
person.principal --has_spouse--> person.principal
person.principal --parent_of--> person.member
person.member --attends--> org.school
org.school --requires--> obligation.deadline
obligation.deadline --covers--> person.member
place.property --serviced_by--> org.vendor    { since: date, contract: doc_id }
place.property --contains--> asset.equipment
asset.equipment --requires--> obligation.recurring
person.principal --prefers--> org.airline     { class: business, seat: aisle }
person.principal --works_at--> org.employer
person.principal --advised_by--> person.contact { role: attorney }
action --performed_for--> person.principal
action --authorized_by--> policy
action --used--> permission
document.policy --insures--> asset.vehicle    { expires: date }
```

All relationships are directional and versioned. "Prefers airline X"
today does not overwrite yesterday's "preferred airline Y"; it
supersedes it, and history remains queryable.

## Provenance and confidence

Every node and edge carries:

- `source` — where the fact came from. Enum: `customer_direct`,
  `customer_document`, `manager_observed`, `agent_inferred_email`,
  `agent_inferred_calendar`, `agent_inferred_action_outcome`,
  `integration_pull` (with subtype), `bulk_import`.
- `source_ref` — a pointer to the specific artifact (message id,
  document id, action id).
- `asserted_by` — the identity that wrote it (customer id, manager id,
  agent name + version).
- `asserted_at` — timestamp.
- `confidence` — 0.0–1.0.
- `status` — `candidate` | `confirmed` | `retired`.
- `superseded_by` — pointer to the successor fact, if retired.

## Learning: how facts become truth

The system learns continuously, but never silently. There are four
promotion paths from `candidate` to `confirmed`:

1. **Customer confirms.** The manager or the customer explicitly
   validates. Trivially promotes.
2. **Manager confirms.** A manager reviewing an exception validates.
   Promotes.
3. **Repeated observation.** The same fact is asserted from ≥N
   independent sources or ≥N times over time without contradiction.
   Thresholds are per-entity-type and tuned per household risk tier
   (a HNW household has higher thresholds).
4. **Action outcome.** An action was proposed on the basis of a
   candidate fact, was executed, and did not fail or get rolled back.
   The fact is promoted; the action is the source_ref.

Retirement is symmetric: contradictory evidence from a higher-authority
source retires the older fact.

## What is *not* stored in the graph

- Raw email/message bodies. The graph stores structured facts
  extracted from them and pointers into the mail store; not copies.
- Credentials. Ever. See [`23-data-model.md`](./23-data-model.md) on the credential vault.
- Financial account balances or transaction detail beyond what is
  strictly needed for a scheduled task. If a bill agent needs to know
  a card is on file at vendor X, that fact lives here; the card number
  does not.
- Health information beyond appointment logistics, unless a household
  explicitly opts in to a medical coordination service (which is a
  separate SKU with its own compliance stance).

## Query patterns the graph must support

The schema exists to serve these queries cheaply:

1. **"What needs my customer's attention in the next 30 days?"** —
   traverse `obligation.*` where deadline < now + 30d and status is
   not resolved.
2. **"If Tuesday moves to Wednesday, what breaks?"** — subgraph query
   over calendar, family, and vendor edges touching the affected time
   window.
3. **"Who does the customer trust for X?"** — traverse
   `prefers -> org.vendor` filtered by service type, ranked by recent
   positive `action` outcomes.
4. **"What did we do last time this happened?"** — pattern-match
   prior `action` sequences with similar triggers.
5. **"What's expired or about to?"** — index over
   `document.*.expires_at` and `obligation.deadline.due_at`.
6. **"Who has authority to approve this?"** — `policy` traversal.
7. **"Show me everything we touched for principal P in the last week"**
   — `action.performed_for` filtered by time.

The storage decision (graph DB vs. relational-with-graph-views vs.
hybrid) is deferred; the ontology and the query patterns are the
commitment. See [`23-data-model.md`](./23-data-model.md).

## Ontology governance

The type catalog is a versioned artifact. Adding a new entity or
relationship type is a spec-level change, not a feature-level change.
This is intentional: the graph's value is coherence. A world where
every agent invents its own types is a world where nothing joins.

- Proposals go through spec review.
- Migrations backfill or leave old data addressable under the old
  type; nothing is silently retyped.
- Deprecated types remain readable indefinitely.
