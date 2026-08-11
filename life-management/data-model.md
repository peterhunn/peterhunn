# Data Model, Storage & Security

This document specifies how the Life Graph, the action ledger, the
credential vault, and everything else are stored, isolated, secured,
and recovered. The ontology in `knowledge-graph.md` is the *what*;
this is the *how*.

## Design commitments

1. **One customer, one tenancy boundary.** A household is the tenant.
   Nothing crosses that boundary except explicitly modeled
   cross-household relations (rare) with explicit consent.
2. **Encryption at rest per-household.** Every household's data is
   encrypted under a household-scoped key. Compromise of one
   household's key does not compromise another's.
3. **Credentials are never in the graph.** They live in a separate
   vault, referenced by opaque handles.
4. **Every read of sensitive data is logged.** Not just writes.
5. **Data is portable.** Export produces a documented, versioned
   archive that reconstructs the graph. This is a contractual
   commitment to the customer, not just a nice feature.
6. **Retention is intentional.** Every entity type has a defined
   retention policy, and the customer can shorten it.

## Logical stores

The system has five logical stores. Physical realization is deferred;
the boundaries are not.

| Store | Contents | Access pattern | Retention |
| --- | --- | --- | --- |
| **Graph store** | Nodes, edges, versions, provenance. | High-QPS reads, moderate writes, complex traversals. | Lifetime of relationship + statutory. |
| **Action ledger** | Every action + policy check + audit record. Append-only. | Append writes; range/point reads for audit and analytics. | 7 years default; configurable up. |
| **Content store** | Documents, attachments, transcripts, extracted artifacts. | Blob reads; content-addressed. | Per document class; customer-tunable. |
| **Credential vault** | OAuth tokens, API keys, session material for third-party access. | Rare, gated reads. Frequent rotations. | Bound to the permission's lifetime; destroyed on revoke. |
| **Mail cache** | Provider-side message references + selective structured extractions. NOT full bodies by default. | Read via provider; extracted facts flow to the graph. | Follows provider retention; extractions follow document rules. |

## Tenancy

- **Household** is the tenancy id, present on every row of every
  store.
- The graph store enforces household scoping at the query layer; no
  agent-facing query can omit household.
- The credential vault enforces household scoping at the key layer;
  attempting to decrypt cross-household material fails
  cryptographically, not just at policy.
- Analytics queries that span households are only run on a separate
  aggregated view with (a) k-anonymity thresholds and (b) no
  free-text or document contents. Never on the live stores.

## Keys and encryption

- **Root KMS** — cloud-KMS backed. Never leaves the KMS.
- **Household master key (HMK)** — one per household, wrapped by
  root KMS. Rotated on a schedule and on suspected exposure.
- **Per-store data keys** — derived from HMK. Rotation of an HMK
  triggers re-wrap, not re-encryption (for cost); re-encryption
  runs as a background task.
- **Field-level encryption** for the most sensitive fields
  (identity document numbers, health markers, financial account
  identifiers), keyed independently from the row-level key. Even a
  service with row access needs a distinct grant to decrypt these
  fields.
- **Credentials** — encrypted with a separate credential-domain key,
  never accessible to graph or agent code paths.

## Identity

Three identity types, always distinct:

- **Customer identity.** A principal or member, authenticated via
  phone/email/passkey. Authorizes policy changes, approvals, and
  self-service.
- **Manager identity.** An employee, authenticated via SSO with
  hardware key. Authorizes manager-console operations.
- **Delegated identity.** A per-permission identity used to act on
  the customer's behalf against third-party systems. Every action
  taken via delegated identity records the customer identity that
  authorized the delegation and the manager identity that supervised
  it (if any).

Session tokens are short-lived. Long-lived delegated access is
represented in the credential vault, not as bearer material in agent
memory.

## Audit

The audit log is a first-class store, not a byproduct of logging. It
answers three questions on any timeframe:

1. **What did we do for this customer?** — the action ledger.
2. **Who inside the company touched this customer's data?** — access
   log across the graph, content, credential, and console layers.
3. **What data did we hold about this customer at time T?** — the
   graph is versioned; every entity has a valid-from/valid-to; every
   fact has provenance and confidence at the time it was asserted.

The customer can request all three at any time and receive a
machine-readable export within an SLA (initial commitment: 7 days).

## Portability and export

Every household has a defined export format:

- Graph: nodes and edges as JSON-LD against the ATELIER ontology,
  with provenance and versions.
- Action ledger: per-action records with policy trace and outcome.
- Content: original attachments in their original formats, indexed.
- Preferences and policies: the policy DSL documents.

Export is available on demand, on subscription end, and — this is the
important one — as a **live continuous export** to a customer-owned
bucket for households that want a shadow copy. This is a differentiator
against every family-office and concierge service: the customer keeps
their own copy of everything.

## Deletion

- **Soft delete** by default: nodes/edges are marked retired and
  hidden from agent queries but retained in the audit tail.
- **Hard delete** on customer request, within statutory allowances.
  Hard delete cascades to derived data (extractions, embeddings).
- **Right-to-be-forgotten** for a person node also propagates to
  content-store artifacts referencing that person, subject to legal
  hold.
- **On subscription end**: 30-day grace with data intact; then
  archival of the audit log for the statutory period; then hard
  delete of the graph and content.

## Retention defaults

| Entity | Default retention | Customer-tunable? |
| --- | --- | --- |
| Actions | 7 years | Longer only |
| Documents (identity) | Until superseded or customer removes | Yes |
| Documents (policy/legal) | Contract lifetime + 7 years | Longer only |
| Documents (receipts) | 3 years | Both directions |
| Preferences | Lifetime of relationship | Both directions |
| Interactions | 2 years | Both directions |
| Extracted email facts | 2 years | Both directions |
| Raw mail cache | 90 days (structured refs only) | Down only |
| Credentials | Bound to permission | — |
| Audit log | 7 years | Longer only |

## Compliance posture

The initial regulatory scope, in likely order of exposure:

- **State privacy laws (US)** — CCPA/CPRA and successors, and
  emerging state comprehensive privacy laws. The rights (access,
  deletion, portability, opt-out of sale) map cleanly to the model
  above. Sale of data is not permitted by the business model, so
  the opt-out is trivial.
- **GDPR-adjacent hygiene from day one** even before serving EU
  households. Data minimization, provenance, right of access are
  cheaper to build in than to retrofit.
- **Financial-adjacent care** — if the service holds payment method
  handles at vendors, we hold *handles*, not card numbers. Full PCI
  scope is avoided by never storing PAN.
- **Health data** — deliberately out of scope for the base product.
  A future medical-coordination SKU would carry HIPAA scope, be
  physically and logically isolated, and be built with dedicated
  BAAs.
- **Legal privilege** — communications with the customer's counsel
  are flagged in the graph and never used as training data of any
  kind, even in aggregate.

## What is *not* in this data model

- A training corpus of customer data. Customer data is not used to
  train shared models. Learning is per-household, in the graph,
  provenance-tagged.
- A cross-household recommendation system. Vendor recommendations
  come from the household's own history and manager-curated
  known-good vendors, not from statistical patterns across other
  customers.
- A user-generated-content surface of any kind.
- Third-party analytics SDKs on any customer-facing surface.

## Operational realities the model must handle

- **A principal loses their phone.** Passkey rotation flow, session
  invalidation, manager-assisted identity re-verification with
  documented KBA fallback.
- **A relationship ends** (divorce, separation). Household split
  procedure: a defined process for cleaving one household into
  two, with policy on shared assets, shared calendars, shared
  children, and shared documents. This is a real operational and
  emotional event; the data model has to make it possible without
  data leakage in either direction.
- **A principal dies.** Estate mode: a defined access change,
  documented in advance if the customer wants, that hands
  designated data to designated recipients under counsel review.
- **A manager leaves the company.** All active sessions revoked
  within minutes; all households reassigned; audit access preserved
  read-only for a defined offboarding window.
- **A vendor breach elsewhere.** If a third-party service where we
  hold delegated access is breached, rotate all our tokens for that
  vendor across all households automatically, notify affected
  households, and open manager review for any actions that used
  those tokens within the exposure window.

The model isn't finished until these scenarios have a defined,
rehearsed path.
