# Legal Agents Infrastructure — Technical Overview

A TypeScript-first SDK for building, executing, and trading AI-driven legal contracts — and the x430 open protocol that makes contracts machine-readable across the internet.

---

## The Problem

Contracts govern nearly every commercial relationship, yet they are entirely invisible to AI agents. An agent can browse the web, call APIs, and make payments via x402 — but when it reaches a data provider, a service agreement, or a liability waiver, it hits a wall: a PDF, an HTML click-wrap, or a legal department. The agent cannot read the contract, cannot negotiate it, cannot execute it, and cannot prove it agreed.

This infrastructure solves that. It gives contracts the same machine-readable, agent-traversable structure that x402 gives to payments.

---

## Architecture

The stack is a TypeScript monorepo with five packages:

```
@legal-agents/core          — contract primitives (model, template, logic)
@legal-agents/agents        — LLM agent layer (tools, reasoning, drafting)
@legal-agents/api           — HTTP API + agentic runtime (executor, webhooks, audit)
@legal-agents/protocol      — x430 HTTP contracting protocol
@legal-agents/store-postgres — Postgres implementations of all stores
```

Each layer is independently useful. A team building a smart contract platform might use only `core` and `protocol`. A legal tech company building a SaaS product would use all five.

---

## The Contract Stack

Every contract has three layers, mirroring the Accord Project architecture:

### Layer 1: Text

Human-readable Markdown with `{{variable}}` placeholders. Corresponds to a Cicero template. The SDK represents this as a `ContractTemplate<T>`:

```typescript
const ndaTemplate = defineTemplate<NDAData>({
  templateId: "org.accordproject.nda",
  text: `
# Non-Disclosure Agreement

This agreement is made between **{{disclosingParty.name}}** ("Disclosing Party")
and **{{receivingParty.name}}** ("Receiving Party") as of {{effectiveDate}}.

The Receiving Party agrees to maintain confidentiality for {{durationMonths}} months
under the laws of {{governingLaw}}.
  `,
  draft: (data) => { /* fill placeholders */ },
  parse: (text) => { /* extract structured data */ },
});
```

### Layer 2: Data

Structured JSON matching a typed TypeScript interface. Corresponds to a Concerto `.cto` model. The SDK represents this as a `ContractModel<T>`:

```typescript
interface NDAData extends ContractData {
  $class: "org.accordproject.nda.NDAContract";
  disclosingParty: Party;
  receivingParty: Party;
  effectiveDate: string;       // ISO 8601
  durationMonths: number;
  jurisdiction: string;
  governingLaw: string;
  confidentialInfo: string;
  mutual: boolean;
}

const ndaModel = defineModel<NDAData>({
  $class: "org.accordproject.nda.NDAContract",
  validate: (data) => { /* runtime validation */ },
});
```

### Layer 3: Logic

TypeScript functions that execute contract obligations and state transitions. Corresponds to Ergo clauses, but expressed as plain TypeScript — no DSL, no runtime dependency.

```typescript
const ndaLogic: ContractLogic<NDAData, NDAEvent, NDAResponse> = {
  init(data) {
    // Called once when the contract is activated.
    // Returns the initial ContractState including obligations.
    return initialState({ obligations: [...] });
  },

  execute(event, ctx) {
    // Called for each party event (DISCLOSURE_MADE, BREACH_NOTIFIED, ...).
    // Returns new state + result + optional emitted events.
    switch (event.type) {
      case "DISCLOSURE_MADE": return handleDisclosure(event, ctx);
      case "BREACH_NOTIFIED":  return handleBreach(event, ctx);
      // ...
    }
  },

  onObligationDue(obligation, ctx) {
    // Called automatically by ObligationExecutor when a deadline passes.
    // Marks obligation fulfilled; closes contract if all obligations settle.
  },
};
```

---

## `@legal-agents/core`

The foundation. No dependencies beyond TypeScript.

**Key types:**

| Type | Description |
|---|---|
| `ContractData` | Base interface all contract data models extend |
| `Party` | `{ partyId, name, role? }` |
| `Obligation` | `{ obligationId, party, action, deadline, status }` |
| `ObligationStatus` | `"pending" \| "fulfilled" \| "breached" \| "excused"` |
| `ContractState` | `{ status, obligations[], history[], metadata }` |
| `ContractStatus` | `"draft" \| "active" \| "completed" \| "breached" \| "terminated"` |
| `ContractEvent` | Base event with `$class`, `eventId`, `timestamp`, `party?`, `payload` |
| `ContractResponse<T>` | `{ state, result, error?, emit? }` |

**Key functions:**

- `defineModel<T>(meta)` — creates a typed `ContractModel<T>`
- `defineTemplate<T>(spec)` — creates a `ContractTemplate<T>` with `draft()` and `parse()`
- `initialState(overrides?)` — creates a blank active `ContractState`

---

## `@legal-agents/agents`

LLM-powered contract reasoning layer. Provider-agnostic via `LLMClient` interface.

### LLM Tools

Seven function-calling tools exposed to the model:

| Tool | Description |
|---|---|
| `parse_contract` | Extract structured `ContractData` from raw text |
| `draft_contract` | Generate contract text from structured data |
| `extract_obligations` | List all obligations with parties and deadlines |
| `check_compliance` | Check a party's actions against contract obligations |
| `analyze_clause` | Flag ambiguous, one-sided, or unenforceable clauses |
| `trigger_event` | Fire a contract event and return the new state |
| `compare_contracts` | Diff two contracts and highlight material differences |

### ContractAgent

```typescript
const agent = new ContractAgent(contractModel, llmClient);

// Natural language → structured data → drafted contract text
const { data, text } = await agent.draft(
  "Draft an NDA between Acme Corp and Beta Inc for 2 years covering product roadmaps",
);

// Text → structured data (parse mode)
const { data } = await agent.parse(rawContractText);

// Multi-turn analysis
const analysis = await agent.analyze(contract, "Is the liability cap enforceable in California?");

// Compliance check
const result = await agent.checkCompliance(
  contract,
  "Beta Inc shared roadmap details with a third party",
);
```

### Providers

`AnthropicClient` is bundled. Any `LLMClient` implementation works:

```typescript
interface LLMClient {
  complete(systemPrompt: string, messages: Message[], tools?: Tool[]): Promise<CompletionResult>;
}

// Bundled:
const llm = new AnthropicClient(new Anthropic(), "claude-opus-4-7");
```

---

## `@legal-agents/api`

The HTTP API layer. Built on Hono (runs on Node.js, Cloudflare Workers, Bun).

### Contract Registry

Register contract types (model + template + logic) by name:

```typescript
const registry = new ContractRegistry()
  .register("nda", { model: ndaModel, template: ndaTemplate, logic: ndaLogic })
  .register("msa", { model: msaModel, template: msaTemplate, logic: msaLogic });
```

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/contracts` | Create a draft contract |
| `GET` | `/contracts/:id` | Fetch contract state |
| `POST` | `/contracts/:id/activate` | Activate a draft (runs `logic.init`) |
| `POST` | `/contracts/:id/events` | Send a party event (runs `logic.execute`) |
| `GET` | `/contracts/:id/audit` | Fetch audit log entries |
| `GET` | `/contracts/:id/audit/verify` | Verify Merkle DAG integrity |
| `POST` | `/keys` | Create an API key |
| `GET` | `/keys` | List API keys |
| `DELETE` | `/keys/:id` | Revoke an API key |
| `POST` | `/webhooks` | Register a webhook |
| `GET` | `/webhooks` | List webhooks |
| `DELETE` | `/webhooks/:id` | Remove a webhook |

### Authentication

Every request requires an API key in `Authorization: Bearer <key>`. Keys are:

- Scoped to an **organisation**
- Optionally bound to a **party** (`partyId`) — when a key is party-bound, events sent with it automatically carry the correct `party` field without trusting client input
- Modes: `"live"` or `"test"`

```bash
# Create a party-bound key for the receiving party
curl -X POST /keys -H "Authorization: Bearer $ADMIN_KEY" \
  -d '{ "name": "beta-agent", "mode": "live", "partyId": "beta" }'

# Send an event — party is inferred from the key, no "party" field needed
curl -X POST /contracts/$ID/events -H "Authorization: Bearer $BETA_KEY" \
  -d '{ "eventType": "DISCLOSURE_MADE", "payload": { "description": "Q1 roadmap" } }'
```

### Webhooks

Webhooks fire on four event types with HMAC-SHA256 signatures (`X-Legal-Agents-Signature`):

| Event | Trigger |
|---|---|
| `contract.activated` | Contract moves from draft to active |
| `contract.event.processed` | A party event is executed |
| `contract.status.changed` | Contract status changes (breached, completed, terminated) |
| `obligation.status.changed` | An obligation is fulfilled, breached, or excused |

### Merkle DAG Audit Log

Every action is recorded in a cryptographic Merkle DAG:

- Each entry hashes its content + sorted parent hashes → tamper-evident chain
- Deletion of any entry breaks the hash chain and is immediately detectable
- `GET /contracts/:id/audit/verify` returns `{ valid, entryCount, tips, roots, errors }`
- `computeEntryHash()` and `verifyEntries()` are exported for independent auditors

```
root ──→ A ──→ B ──→ D
              ↗
         C ──╯
```

Hash of D = SHA-256(canonicalize({ ...D, parentHashes: sort([hash(B), hash(C)]) }))

### ObligationExecutor

An autonomous background worker that monitors contract obligations:

```typescript
startServer({
  registry,
  llm,
  apiKeys,
  executorIntervalMs: 30_000, // poll every 30 seconds
});
```

On each tick:
1. Queries `findWithDueObligations(now)` — contracts with pending, past-deadline obligations
2. For each due obligation, calls `logic.onObligationDue?()` or falls back to a `OBLIGATION_DUE` event
3. Accumulates new state, records to audit DAG, fires webhooks
4. All executor entries carry `SYSTEM_KEY_ID` in the audit log for traceability

---

## x430 — HTTP Contracting Protocol

x430 is an open HTTP protocol that makes legal agreements machine-readable and agent-traversable, extending x402 (payment) to add a legal layer to the agentic commerce stack.

```
Discovery → [x430: Contract Agreement] → [x402: Payment] → Fulfillment → Dispute
```

### Status Codes

| Code | Meaning in x430 |
|---|---|
| `430` | Contract required — server returns `X-430-Requirements` |
| `402` | Payment required — may embed `contractRequired` for combined gate |
| `200` | Request accepted — both gates satisfied |

### Headers

| Header | Direction | Content |
|---|---|---|
| `X-430-Requirements` | Server → Client | base64(JSON(ContractRequirements)) |
| `X-430-Contract` | Client → Server | Signed agreement token |

### Flow: Contract Gate

```
→  GET /resource
←  430  X-430-Requirements: <base64>

→  GET <templateUrl>          (fetch + verify SHA-256)
←  200  { template, model }

→  POST <acceptEndpoint>
   { templateId, templateHash, partyData, negotiationTerms? }
←  200  { status: "accepted", contractId, token }

→  GET /resource
   X-430-Contract: <token>
←  200  OK
```

### Flow: Combined x402 + x430

```
→  GET /resource
←  402  { x402Version: 1, accepts: [...], contractRequired: {...} }

   (establish x430 agreement → token)
   (pay via x402 facilitator → X-PAYMENT proof)

→  GET /resource
   X-430-Contract: <token>
   X-PAYMENT: <proof>
←  200  OK
```

### ContractRequirements Object

```typescript
interface ContractRequirements {
  scheme: "x430";
  version: 1;
  templateId: string;           // "org.accordproject.saas-msa"
  templateUrl: string;          // fetch the template here
  templateHash: string;         // hex SHA-256 — client verifies before signing
  requiredPartyFields: string[]; // must be present in partyData
  jurisdiction?: string;
  governingLaw?: string;
  acceptEndpoint: string;       // POST here to accept / propose
  verifyEndpoint?: string;      // optional facilitator
  expiresIn: number;            // offer TTL in seconds
  resource: string;             // path being gated, or "*"
  description: string;
  negotiable: boolean;
  negotiableFields?: NegotiableField[];
}
```

### Structured Negotiation

When `negotiable: true`, servers advertise exactly which fields are open for discussion and what values are acceptable:

```typescript
interface NegotiableField {
  field: string;            // e.g. "jurisdiction"
  allowedValues?: string[]; // constrained set — agent picks from this list
  description: string;      // agent-readable explanation
}
```

Example server advertisement:

```json
{
  "negotiable": true,
  "negotiableFields": [
    {
      "field": "jurisdiction",
      "allowedValues": ["California, USA", "Delaware, USA", "New York, USA"],
      "description": "Governing jurisdiction for dispute resolution."
    },
    {
      "field": "expiresIn",
      "allowedValues": ["3600", "86400", "2592000"],
      "description": "Token validity: 1 hour, 1 day, or 30 days."
    }
  ]
}
```

Agent negotiation loop:

```typescript
const client = new ContractClient({
  partyData: { name: "Acme AI", jurisdiction: "California, USA" },
  onNegotiation: async (requirements) => {
    const { negotiableFields } = requirements;
    // Agent reads negotiableFields, selects preferred values from allowedValues
    const jurisdiction = negotiableFields
      ?.find(f => f.field === "jurisdiction")
      ?.allowedValues?.includes("Delaware, USA")
      ? "Delaware, USA"
      : undefined;
    return jurisdiction ? { jurisdiction } : undefined;
  },
});

const response = await client.fetch("https://api.example.com/data");
```

The `acceptHandler` middleware validates proposals automatically:
- Rejects fields not listed in `negotiableFields` with `400 { error: "proposed fields are not negotiable" }`
- Rejects values outside `allowedValues` with `400 { error: "proposed value not in allowedValues" }`
- Calls `onNegotiation` only after structural validation passes

### Negotiation Round-Trip

```
→  POST /contracts/accept
   { negotiationTerms: { jurisdiction: "New York, USA" } }
←  200  { status: "counter_offer", counterOffer: { jurisdiction: "Delaware, USA", ... } }

→  POST /contracts/accept
   { negotiationTerms: { jurisdiction: "Delaware, USA" } }
←  200  { status: "accepted", contractId, token }
```

### AgreementToken

Self-contained signed token carried in `X-430-Contract`. Verifiable offline without calling the server.

```typescript
interface AgreementToken {
  scheme: "x430";
  payload: {
    contractId: string;
    templateHash: string;   // binds token to a specific contract template
    partyId: string;
    resource: string;       // path or "*"
    iat: number;            // issued-at (Unix seconds)
    exp: number;            // expires-at (Unix seconds)
  };
  signature: string;        // hex HMAC-SHA256(secret, JSON.stringify(payload))
}
```

Offline verification steps:
1. base64-decode and JSON-parse
2. Check `scheme === "x430"`
3. Check `payload.exp > now`
4. Check `payload.resource === requestPath || payload.resource === "*"`
5. Recompute HMAC-SHA256 and compare in constant time

### Facilitator Pattern

Like x402 facilitators, servers may delegate token signing and verification to a trusted third party. The facilitator holds the HMAC secret; servers verify by calling `GET <verifyEndpoint>?token=<raw>&resource=<path>` and trust the response. This enables multi-tenant deployments where individual servers hold no key material.

### Security

| Concern | Mitigation |
|---|---|
| Replay attacks | `exp` field; high-value flows may track `contractId` as single-use nonce |
| Template substitution | Client verifies `templateHash` (SHA-256) before signing |
| HMAC secret exposure | Server-side only; facilitator pattern keeps secrets off application servers |
| Negotiation abuse | Rate-limit round-trips; `negotiable: false` by default |
| Enforceability | x430 proves cryptographic agreement, not legal enforceability — jurisdiction and applicable law are the parties' responsibility |

---

## `@legal-agents/store-postgres`

Production-grade Postgres implementations of all four stores.

### Schema

```sql
organizations    -- org_id (PK), name, created_at
api_keys         -- id, org_id, name, key_hash, mode, party_id, created_at, revoked_at
contracts        -- id, org_id, type, data (JSONB), state (JSONB), created_at, updated_at
audit_log        -- id, org_id, key_id, contract_id, action, payload (JSONB),
                 --   parent_hashes TEXT[], hash TEXT NOT NULL, created_at
audit_log_tips   -- (org_id, scope, hash) PK — O(1) Merkle DAG tip lookup
webhooks         -- id, org_id, url, secret, events TEXT[], created_at
webhook_deliveries -- id, webhook_id, event_type, status, attempts, ...
```

### Key design: `audit_log_tips`

Rather than scanning the full `audit_log` table to find DAG tips, we maintain a `audit_log_tips` table transactionally with each insert:

```sql
-- In a single transaction:
SELECT hash FROM audit_log_tips WHERE org_id = $1 AND scope = $2 FOR UPDATE;
-- (compute new entry hash using parent hashes)
INSERT INTO audit_log ...;
DELETE FROM audit_log_tips WHERE hash = ANY($parentHashes);
INSERT INTO audit_log_tips (org_id, scope, hash) VALUES (...) ON CONFLICT DO NOTHING;
```

This gives O(1) tip lookup without a table scan, at the cost of one extra write per audit entry.

### JSONB obligation queries

`findWithDueObligations` uses a Postgres JSONB path query to find active contracts with overdue pending obligations without loading all contracts into memory:

```sql
SELECT * FROM contracts
WHERE state->>'status' = 'active'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(state->'obligations') AS o
    WHERE o->>'status' = 'pending'
      AND (o->>'deadline')::timestamptz <= $now::timestamptz
  )
```

### Running migrations

```bash
DATABASE_URL=postgresql://user:pass@localhost/legal_agents npm run migrate
```

---

## Getting Started

### 1. Install

```bash
npm install @legal-agents/core @legal-agents/agents @legal-agents/api @legal-agents/protocol
```

### 2. Define a contract

```typescript
import { defineModel, defineTemplate, initialState } from "@legal-agents/core";
import type { ContractLogic } from "@legal-agents/core";

const myModel = defineModel<MyData>({ $class: "com.example.MyContract", validate: () => {} });
const myTemplate = defineTemplate<MyData>({ templateId: "com.example.MyContract", text: "...", draft: ..., parse: ... });
const myLogic: ContractLogic<MyData> = { execute: (event, ctx) => ({ state: ctx.state, result: {} }) };
```

### 3. Start the server

```typescript
import { ContractRegistry, startServer, InMemoryApiKeyStore } from "@legal-agents/api";

const registry = new ContractRegistry().register("my-contract", { model: myModel, template: myTemplate, logic: myLogic });
const apiKeys = new InMemoryApiKeyStore();
const { raw: adminKey } = await apiKeys.create("my-org", "admin", "live");

startServer({ registry, apiKeys, port: 3000, executorIntervalMs: 30_000 });
```

### 4. Gate a resource with x430

```typescript
import { requireContract, acceptHandler, ContractClient } from "@legal-agents/protocol";

// Server
app.get("/data", requireContract({ requirements, secret }), handler);
app.post("/contracts/accept", acceptHandler({ requirements, secret, onAccepted: recordInDB }));

// Agent client
const client = new ContractClient({ partyData: { name: "My Agent" } });
const res = await client.fetch("https://api.example.com/data");
```

---

## Reference: x430 at a Glance

```
                    ┌─────────────────────────────────────┐
                    │           x430 Protocol              │
                    │                                      │
  Agent             │  Server                              │
    │               │    │                                 │
    │── GET /data ──┼──→ │                                 │
    │               │    │ ← 430 X-430-Requirements        │
    │               │    │                                 │
    │── GET template┼──→ │                                 │
    │               │    │ ← 200 { text, model, hash }    │
    │               │    │                                 │
    │── POST accept ┼──→ │ (negotiate if needed)           │
    │               │    │ ← 200 { token }                │
    │               │    │                                 │
    │── GET /data   │    │                                 │
    │   X-430-Contract ──┼──→ verify HMAC offline         │
    │               │    │ ← 200 OK                       │
    └───────────────┴────┴─────────────────────────────────┘

  Token:  base64({ scheme:"x430", payload:{contractId,partyId,exp,...}, signature:HMAC })
  Verify: HMAC-SHA256(secret, JSON.stringify(payload)) — constant-time compare
```
