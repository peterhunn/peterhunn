# Legal Agents Protocol (LAP/1.0)

A machine-readable contracting protocol for HTTP, designed as a legal layer
in the agentic commerce stack — complementing x402 (payment) and broader
agent coordination protocols such as UCP.

---

## Abstract

LAP defines how an HTTP server advertises that a resource requires a legal
agreement, how a client (human-driven or agentic) establishes that agreement,
and how subsequent requests prove it. The protocol is:

- **Stateless at the wire level** — agreement proof is a self-contained signed
  token carried in a request header, no session required.
- **Negotiable** — servers may accept or counter-offer, enabling agents to
  agree on modified terms before committing.
- **x402-composable** — servers that require both payment and a legal agreement
  embed a `contractRequired` field in the standard x402 402 body; clients
  satisfy both gates in a single retry.
- **Facilitator-ready** — like x402, servers may delegate token issuance and
  verification to a trusted third-party facilitator.

---

## Motivation

x402 solves machine-readable payment: a server returns a 402 with payment
requirements, a client pays and retries with proof. The result is that AI
agents can autonomously acquire access to paid resources.

The missing layer is *legal agreement*. Many resources require not just
payment but a binding agreement: a terms-of-service, an NDA, a data-use
policy, a liability waiver. Today these are HTML click-wraps — invisible to
agents.

LAP closes that gap. An agent that can traverse x402 can traverse LAP with
the same agentic loop:

```
while response.status in (402, 403):
    satisfy_requirements(response)
    response = retry(request)
```

Within a UCP-style commerce lifecycle the layers map as:

```
Discovery → [LAP: Contract Agreement] → [x402: Payment] → Fulfillment → Dispute
```

---

## Protocol Flow

### 1. Contract gate only (no payment required)

```
Client                                    Server
  |                                          |
  |── GET /resource ──────────────────────→  |
  |                                          |
  |← 403 Contract Required ─────────────────|
  |  X-Contract-Requirements: <base64>       |
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
  |         contractId, token }             |
  |                                          |
  |── GET /resource ──────────────────────→  |
  |   X-Contract-Agreement: <token>          |
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
  |    contractRequired: {...},  ← LAP extension
  |  }                                       |
  |                                          |
  |  (establish contract → get LAP token)    |
  |  (pay via x402 facilitator → get X-PAYMENT proof)
  |                                          |
  |── GET /resource ──────────────────────→  |
  |   X-Contract-Agreement: <lap-token>      |
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
  |  (client reviews counter-offer,          |
  |   optionally adjusts terms, retries)     |
  |── POST <acceptEndpoint> ───────────────→ |
  |← 200 { status: "accepted", token }      |
```

---

## HTTP Headers

| Header | Direction | Description |
|---|---|---|
| `X-Contract-Requirements` | Server → Client | base64(JSON(ContractRequirements)) on 403 |
| `X-Contract-Agreement` | Client → Server | Signed agreement token on subsequent requests |

---

## Data Types

### ContractRequirements

Returned by the server to describe what agreement is needed.

```typescript
interface ContractRequirements {
  scheme: "legal-agents/v1";
  version: 1;
  templateId: string;           // e.g. "org.accordproject.saas-msa"
  templateUrl: string;          // fetch the human+machine-readable template
  templateHash: string;         // hex SHA-256 of template content (integrity)
  requiredPartyFields: string[]; // fields the client must supply in partyData
  jurisdiction?: string;        // e.g. "California, USA"
  governingLaw?: string;        // e.g. "laws of the State of California"
  acceptEndpoint: string;       // POST here to accept or propose terms
  verifyEndpoint?: string;      // GET here to verify a token (facilitator)
  expiresIn: number;            // offer validity in seconds
  resource: string;             // resource path being gated
  description: string;          // human-readable description
  negotiable: boolean;          // whether negotiationTerms are accepted
}
```

### AcceptRequest

Posted by the client to the `acceptEndpoint`.

```typescript
interface AcceptRequest {
  templateId: string;
  templateHash: string;           // must match ContractRequirements.templateHash
  partyData: Record<string, string>; // values for requiredPartyFields
  negotiationTerms?: Record<string, unknown>; // proposed modifications (if negotiable)
}
```

### AcceptResponse

```typescript
interface AcceptResponse {
  status: "accepted" | "counter_offer";
  contractId: string;
  token: string;                  // base64(JSON(AgreementToken)) — present when accepted
  counterOffer?: ContractRequirements; // present when status === "counter_offer"
}
```

### AgreementToken

Carried in `X-Contract-Agreement`. Self-contained and verifiable offline.

```typescript
interface AgreementToken {
  scheme: "legal-agents/v1";
  payload: {
    contractId: string;
    templateHash: string;
    partyId: string;
    resource: string;   // "*" for wildcard (all resources on this server)
    iat: number;        // issued-at (Unix seconds)
    exp: number;        // expires-at (Unix seconds)
  };
  signature: string;    // hex HMAC-SHA256(secret, JSON.stringify(payload))
}
```

---

## Token Verification

Servers verify `X-Contract-Agreement` offline without calling out:

1. base64-decode and JSON-parse the token.
2. Check `scheme === "legal-agents/v1"`.
3. Check `payload.exp > now`.
4. Check `payload.resource === requestPath || payload.resource === "*"`.
5. Recompute `HMAC-SHA256(secret, JSON.stringify(payload))` and compare to `signature` in constant time.

Facilitator mode: if `ContractRequirements.verifyEndpoint` is set, servers may
delegate step 5 to `GET <verifyEndpoint>?token=<raw>` and trust the
facilitator's response instead of holding the signing secret themselves.

---

## x402 Integration

Servers that require both legal agreement and payment extend the standard x402
402 response body with a `contractRequired` field:

```json
{
  "x402Version": 1,
  "accepts": [{ "scheme": "exact", "network": "base", ... }],
  "contractRequired": { "scheme": "legal-agents/v1", ... }
}
```

Clients that support LAP check for this field. If present, they establish the
contract agreement (obtaining a LAP token) before or in parallel with payment,
then send both `X-Contract-Agreement` and `X-PAYMENT` on the retry.

Clients that do not support LAP see a standard x402 402 and retry with only
`X-PAYMENT`; the server may choose to reject with a 403 and
`X-Contract-Requirements` at that point.

---

## Security Considerations

**Replay attacks**: tokens carry `exp`; servers should also keep a short-lived
nonce cache (or use `contractId` as a single-use token in high-value flows).

**Template integrity**: clients must verify that the fetched template's SHA-256
matches `templateHash` before signing. A server that swaps the template after
issuing requirements would be detected.

**Secret management**: the HMAC secret must be server-side only. In
facilitator mode the facilitator holds the secret; servers receive no key
material.

**Negotiation abuse**: servers should rate-limit and audit negotiation round
trips. Accepting `negotiationTerms` is strictly opt-in (`negotiable: true`).

**Jurisdiction and enforceability**: LAP establishes cryptographic proof of
agreement, not legal enforceability. Parties must ensure the underlying
contract complies with applicable law.

---

## Reference Implementation

`@legal-agents/protocol` — TypeScript package providing:

- `requireContract(opts)` — Hono middleware for server-side contract gates
- `ContractClient` — `fetch`-wrapping client that auto-traverses LAP + x402
- `signToken` / `verifyToken` — token primitives for custom integrations
- `buildX402WithContract` — helper to construct combined x402+LAP responses
- Type definitions for all protocol objects

See `packages/protocol/` in the legal-agents monorepo.
