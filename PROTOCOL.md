# x480 — Machine-Readable Contracting Protocol for HTTP

A legal agreement layer for the agentic commerce stack, named after HTTP 480
("Unavailable For Legal Reasons"). Extends x402 (payment) so that AI agents
can autonomously satisfy both legal and financial gates before accessing a
resource.

---

## Abstract

x480 defines how an HTTP server advertises that a resource requires a legal
agreement, how a client (human or agent) establishes that agreement, and how
subsequent requests prove it. The protocol is:

- **Stateless at the wire level** — agreement proof is a self-contained signed
  token carried in `X-480-Contract`, no session required.
- **Negotiable** — servers may accept or counter-offer, enabling agents to
  agree on modified terms before committing.
- **x402-composable** — servers that require both payment and a legal agreement
  embed a `contractRequired` field in the standard x402 402 body; clients
  satisfy both gates in a single retry.
- **Facilitator-ready** — like x402, servers may delegate token issuance and
  verification to a trusted third-party facilitator.

---

## Motivation

x402 solves machine-readable payment: a server returns 402, a client pays and
retries with proof. Agents can autonomously acquire access to paid resources.

The missing layer is *legal agreement*. Many resources require not just payment
but a binding agreement — terms of service, an NDA, a data-use policy, a
liability waiver. Today these are HTML click-wraps invisible to agents.

x480 closes that gap. An agent that can traverse x402 can traverse x480 with
the same loop:

```
while response.status in (402, 480):
    satisfy_requirements(response)
    response = retry(request)
```

Within a UCP-style commerce lifecycle the layers map as:

```
Discovery → [x480: Contract Agreement] → [x402: Payment] → Fulfillment → Dispute
```

---

## Protocol Flow

### 1. Contract gate only (no payment required)

```
Client                                    Server
  |                                          |
  |── GET /resource ──────────────────────→  |
  |                                          |
  |← 480 Contract Required ─────────────────|
  |  X-480-Requirements: <base64>            |
  |  Body: { error, contractRequired: {...} }|
  |                                          |
  |── GET <templateUrl> ────────────────────→ (fetch contract template)
  |← 200 { template text, model schema }    |
  |                                          |
  |── POST <acceptEndpoint> ───────────────→ |
  |   Body: { templateId, templateHash,      |
  |           partyData, negotiationTerms? } |
  |                                          |
  |← 200 { status: "accepted",              |
  |         contractId, token }              |
  |                                          |
  |── GET /resource ──────────────────────→  |
  |   X-480-Contract: <token>                |
  |← 200 OK ─────────────────────────────── |
```

### 2. Contract + payment (x402 extension)

```
Client                                    Server
  |                                          |
  |── GET /resource ──────────────────────→  |
  |← 402 Payment Required ──────────────────|
  |  Body: {                                 |
  |    x402Version: 1,                       |
  |    accepts: [...],           ← standard x402
  |    contractRequired: {...},  ← x480 extension
  |  }                                       |
  |                                          |
  |  (establish agreement → get x480 token)  |
  |  (pay via x402 facilitator → get X-PAYMENT proof)
  |                                          |
  |── GET /resource ──────────────────────→  |
  |   X-480-Contract: <token>                |
  |   X-PAYMENT: <x402-proof>               |
  |← 200 OK ─────────────────────────────── |
```

### 3. Negotiation (counter-offer)

```
Client                                    Server
  |── POST <acceptEndpoint> ───────────────→ |
  |   Body: { ..., negotiationTerms: {...} } |
  |← 200 { status: "counter_offer",         |
  |         counterOffer: ContractRequirements }
  |                                          |
  |── POST <acceptEndpoint> ───────────────→ |
  |← 200 { status: "accepted", token }      |
```

---

## HTTP Headers

| Header | Direction | Description |
|---|---|---|
| `X-480-Requirements` | Server → Client | base64(JSON(ContractRequirements)) on 480 |
| `X-480-Contract` | Client → Server | Signed agreement token on subsequent requests |

---

## Data Types

### ContractRequirements

```typescript
interface ContractRequirements {
  scheme: "x480";
  version: 1;
  templateId: string;           // e.g. "org.accordproject.saas-msa"
  templateUrl: string;          // fetch the human+machine-readable template
  templateHash: string;         // hex SHA-256 of template content (integrity)
  requiredPartyFields: string[]; // fields the client must supply in partyData
  jurisdiction?: string;
  governingLaw?: string;
  acceptEndpoint: string;       // POST here to accept or propose terms
  verifyEndpoint?: string;      // GET here to verify a token (facilitator)
  expiresIn: number;            // offer validity in seconds
  resource: string;             // resource path being gated, or "*"
  description: string;
  negotiable: boolean;
}
```

### AgreementToken

Carried in `X-480-Contract`. Self-contained and verifiable offline.

```typescript
interface AgreementToken {
  scheme: "x480";
  payload: {
    contractId: string;
    templateHash: string;
    partyId: string;
    resource: string;   // "*" for wildcard
    iat: number;        // issued-at (Unix seconds)
    exp: number;        // expires-at (Unix seconds)
  };
  signature: string;    // hex HMAC-SHA256(secret, JSON.stringify(payload))
}
```

### AcceptRequest / AcceptResponse

```typescript
interface AcceptRequest {
  templateId: string;
  templateHash: string;
  partyData: Record<string, string>;
  negotiationTerms?: Record<string, unknown>; // only when negotiable: true
}

interface AcceptResponse {
  status: "accepted" | "counter_offer";
  contractId: string;
  token: string;                  // base64(JSON(AgreementToken))
  counterOffer?: ContractRequirements;
}
```

---

## Token Verification

Servers verify `X-480-Contract` offline:

1. base64-decode and JSON-parse the token.
2. Check `scheme === "x480"`.
3. Check `payload.exp > now`.
4. Check `payload.resource === requestPath || payload.resource === "*"`.
5. Recompute `HMAC-SHA256(secret, JSON.stringify(payload))` and compare to
   `signature` in constant time.

**Facilitator mode**: if `verifyEndpoint` is set, servers may delegate step 5
to `GET <verifyEndpoint>?token=<raw>&resource=<path>` and trust the
facilitator's response, holding no key material themselves.

---

## x402 Integration

Servers that require both legal agreement and payment extend the standard x402
402 response body with a `contractRequired` field:

```json
{
  "x402Version": 1,
  "accepts": [{ "scheme": "exact", "network": "base", ... }],
  "contractRequired": { "scheme": "x480", ... }
}
```

Clients that support x480 check for `contractRequired`. If present, they
establish the agreement (obtaining an x480 token) before or in parallel with
payment, then send both `X-480-Contract` and `X-PAYMENT` on the retry.

x402-only clients ignore the unknown field and retry with only `X-PAYMENT`;
the server may then respond with 480.

---

## Security Considerations

**Replay**: tokens carry `exp`. High-value flows may also track `contractId`
as a single-use nonce server-side.

**Template integrity**: clients must verify the fetched template's SHA-256
matches `templateHash` before signing. A server swapping the template after
advertising requirements would be detected.

**Secret management**: the HMAC secret is server-side only. In facilitator
mode the facilitator holds the secret; servers receive no key material.

**Negotiation abuse**: servers should rate-limit negotiation round-trips.
Accepting `negotiationTerms` is strictly opt-in (`negotiable: true`).

---

## Reference Implementation

`@legal-agents/protocol` — TypeScript package:

- `requireContract(opts)` — Hono middleware: 480 gate, sets `c.var.x480ContractId` / `c.var.x480PartyId`
- `acceptHandler(opts)` — accept endpoint with negotiation support
- `verifyHandler(opts)` — facilitator verify endpoint
- `ContractClient` — fetch-wrapping agent client that auto-traverses x480 + x402
- `signToken` / `verifyToken` — HMAC-SHA256 primitives
- `buildX402WithContract` — construct combined x402+x480 402 responses
- `x480ExtensionHeaders` — add `X-480-Requirements` alongside x402 402 body

See `packages/protocol/` and `packages/examples/src/x480-demo.ts`.
