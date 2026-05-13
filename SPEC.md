# x490: HTTP Contracting Protocol

**Status:** Draft  
**Reference Implementation:** `@x490/protocol` (TypeScript), `x490` (Python, PyPI)

---

## Abstract

AI agents increasingly transact on behalf of principals, creating demand for a machine-readable protocol that establishes legal agreement before resource access is granted. x490 defines an HTTP-level contracting handshake: a server gates a resource behind status code 490, advertising a tamper-evident contract template; a client fetches and verifies the template, accepts terms, and receives a signed bearer token that unlocks subsequent requests. x490 sits between discovery and payment in the agentic commerce stack: **Discovery → x490 (legal agreement) → x402 (payment) → Fulfillment**.

---

## 1. Status Code 490

HTTP status code **490 Contract Required** is analogous to 402 Payment Required. The number follows naturally from x402: where 402 gates on payment, 490 gates on legal agreement. Both codes sit outside the 4xx range of errors that carry finality — they are challenges requiring client action before the request can succeed.

A 490 response MUST include:

- `Content-Type: application/json`
- `X-490-Requirements: <base64(JSON(ContractRequirements))>`
- A JSON body with at minimum `{ "error": "Contract agreement required", "contractRequired": <ContractRequirements> }`

---

## 2. Protocol Flow

### 2.1 Normal (Single-Party) Flow

```
Client                                   Server
  |                                         |
  |  GET /resource                          |
  |---------------------------------------->|
  |                                         |
  |  490 Contract Required                  |
  |  X-490-Requirements: <base64url(JSON)>  |
  |<----------------------------------------|
  |                                         |
  |  GET <requirements.templateUrl>         |
  |---------------------------------------->|
  |  200 OK  (template body)                |
  |<----------------------------------------|
  |  [client verifies SHA-256 hash]         |
  |                                         |
  |  POST <requirements.acceptEndpoint>     |
  |  Content-Type: application/json         |
  |  { templateId, templateHash,            |
  |    partyData: { ... } }                 |
  |---------------------------------------->|
  |  200 OK                                 |
  |  { status: "accepted",                  |
  |    contractId, token }                  |
  |<----------------------------------------|
  |                                         |
  |  GET /resource                          |
  |  X-490-Contract: <token>                |
  |---------------------------------------->|
  |  200 OK                                 |
  |<----------------------------------------|
```

**Step 1 — Initial request.** The client issues any HTTP request to a gated resource. If the client holds a cached, non-expired token whose `resource` field matches the request path (or is `"*"`), it SHOULD attach it immediately as `X-490-Contract` and skip to step 6.

**Step 2 — 490 challenge.** The server returns 490 with `X-490-Requirements` set to `base64(JSON(ContractRequirements))`. The JSON payload is standard base64 (RFC 4648 §4) over UTF-8-encoded JSON.

**Step 3 — Template fetch and verification.** The client performs a GET to `ContractRequirements.templateUrl`. It MUST compute the SHA-256 hash of the response body and compare it (hex-encoded) against `ContractRequirements.templateHash`. If the hashes do not match the client MUST abort — the template has been tampered with or substituted.

**Step 4 — Accept request.** The client POSTs an `AcceptRequest` to `ContractRequirements.acceptEndpoint`. The body MUST include `templateId`, `templateHash` (matching the previously verified hash), and `partyData` containing every key listed in `ContractRequirements.requiredPartyFields`. The server MUST return 400 if any required field is absent or if `templateHash` does not match its own record.

**Step 5 — Token issuance.** On a valid single-party acceptance, the server returns `AcceptResponse` with `status: "accepted"` and a `token` string. The token is `base64(JSON(AgreementToken))`.

**Step 6 — Authenticated retry.** The client retries the original request with the token in the `X-490-Contract` header. The server decodes and verifies the token; on success it proceeds to handle the request normally.

### 2.2 Header Encoding

| Header | Direction | Value |
|---|---|---|
| `X-490-Requirements` | Server → Client | `base64(JSON(ContractRequirements))` |
| `X-490-Contract` | Client → Server | `base64(JSON(AgreementToken))` |

Both headers use standard base64 (RFC 4648 §4) over UTF-8-encoded JSON. The `b64encode`/`b64decode` functions in the reference implementation encode the full UTF-8 byte stream via `TextEncoder`/`TextDecoder`.

---

## 3. Wire Types

### 3.1 ContractRequirements

```typescript
export interface NegotiableField {
  field: string;           // dot-path key into ContractRequirements or contract model
  allowedValues?: string[]; // if absent, any value may be proposed
  description: string;
}

export interface ContractRequirements {
  scheme: "x490";
  version: 1;
  templateId: string;          // Accord Project-style class name
  templateUrl: string;         // URL to fetch the human+machine-readable template
  templateHash: string;        // hex SHA-256 of template content
  requiredPartyFields: string[]; // keys the client must supply in partyData
  jurisdiction?: string;
  governingLaw?: string;
  acceptEndpoint: string;      // POST here to accept or negotiate
  verifyEndpoint?: string;     // optional facilitator for token verification
  revokeEndpoint?: string;     // POST here to revoke an agreement
  expiresIn: number;           // offer validity in seconds
  resource: string;            // path being gated, or "*" for all paths
  description: string;
  negotiable: boolean;
  negotiableFields?: NegotiableField[];
  requiredParties?: number;    // defaults to 1; > 1 enables multi-party flow
}
```

### 3.2 AcceptRequest

```typescript
export interface AcceptRequest {
  templateId: string;
  templateHash: string;                         // must match ContractRequirements.templateHash
  partyData: Record<string, string>;            // keys per requiredPartyFields
  negotiationTerms?: Record<string, unknown>;   // only when negotiable is true
  pendingContractId?: string;                   // co-signers include this
}
```

### 3.3 AcceptResponse

```typescript
export interface AcceptResponse {
  status: "accepted" | "pending" | "counter_offer";
  contractId: string;
  token: string;                      // base64(JSON(AgreementToken)); empty string when status !== "accepted"
  counterOffer?: ContractRequirements; // present when status === "counter_offer"
  pendingAcceptances?: number;         // present when status === "pending"
  requiredAcceptances?: number;        // present when status === "pending"
}
```

### 3.4 AgreementToken and AgreementPayload

```typescript
export interface AgreementPayload {
  contractId: string;
  templateHash: string;
  partyId: string;
  resource: string;  // path this token is valid for, or "*"
  iat: number;       // issued-at (Unix seconds)
  exp: number;       // expires-at (Unix seconds)
}

export interface AgreementToken {
  scheme: "x490";
  payload: AgreementPayload;
  signature: string;  // hex HMAC-SHA256(secret, JSON.stringify(payload))
}
```

---

## 4. Token Signing and Verification

### 4.1 Signing

The server signs a token by computing HMAC-SHA256 over the UTF-8 encoding of `JSON.stringify(payload)` using the server's secret key. The resulting bytes are hex-encoded (lowercase, zero-padded to 64 characters) and stored in `AgreementToken.signature`. The complete `AgreementToken` object is then JSON-serialised and base64-encoded to form the value placed in `X-490-Contract`.

```
signature = hex(HMAC-SHA256(secret, JSON.stringify(payload)))
token     = base64(JSON.stringify({ scheme: "x490", payload, signature }))
```

### 4.2 Verification

On each request the server MUST:

1. base64-decode and JSON-parse the `X-490-Contract` header value.
2. Assert `token.scheme === "x490"`.
3. Assert `token.payload.exp > floor(Date.now() / 1000)`.
4. Assert `token.payload.resource === "*"` OR `token.payload.resource === requestPath`.
5. Recompute `expected = hex(HMAC-SHA256(secret, JSON.stringify(token.payload)))`.
6. Compare `expected` against `token.signature` using **constant-time comparison** (XOR each character pair; accept only if the accumulated diff is zero). This prevents timing-based secret recovery.

A token that fails any of these checks MUST be treated identically to an absent token — the server returns 490.

---

## 5. Verification Modes

### 5.1 Self-Hosted (Local HMAC)

The server holds the HMAC secret and verifies tokens inline, as described in §4. This is the default mode and requires no external call per request. The `requireContract` middleware accepts a `secret` string and performs all verification locally.

### 5.2 Facilitated (Delegated Verification)

For servers that do not hold key material (stateless edge functions, multi-tenant deployments), `ContractRequirements.verifyEndpoint` may be set to a facilitator URL. The server forwards the raw token and request path to the facilitator via:

```
GET <verifyEndpoint>?token=<encoded-token>&resource=<url-encoded-path>
```

The facilitator returns a `VerifyResponse`:

```typescript
export interface VerifyResponse {
  valid: boolean;
  contractId?: string;
  partyId?: string;
  expiresAt?: number;
  reason?: string;    // present when valid is false
}
```

The calling server accepts the request if and only if `valid === true`. Facilitated mode is activated by setting `facilitated: true` in `ContractGateOptions`, or automatically when `secret` is omitted and `verifyEndpoint` is present.

---

## 6. Multi-Party Contracts

When `ContractRequirements.requiredParties` is greater than 1, a token is not issued until the required number of distinct parties have posted acceptance.

**First party.** A client posts `AcceptRequest` without `pendingContractId`. The server creates a pending contract record (keyed by a new `contractId`) and returns:

```json
{ "status": "pending", "contractId": "<uuid>", "token": "",
  "pendingAcceptances": 1, "requiredAcceptances": 2 }
```

The first party receives the `contractId` and MUST communicate it out-of-band to co-signers.

**Subsequent parties.** Each co-signer posts `AcceptRequest` including `pendingContractId` set to the value returned above. The server adds the party to the pending record and returns an updated `pending` response until the threshold is met.

**Token issuance.** When the final required party signs, the server issues the token as in the single-party case. The `payload.partyId` field is set to the concatenation of all party identifiers joined by `"+"`.

The `PendingContractStore` interface provides `create`, `addParty`, `get`, and `complete` operations. An `InMemoryPendingContractStore` is included in the reference implementation for development and testing; production deployments SHOULD use a persistent store.

---

## 7. Negotiation

When `ContractRequirements.negotiable` is `true`, a client MAY include `negotiationTerms` in its `AcceptRequest`. The `negotiationTerms` object is a map of dot-path field names to proposed values.

**Constraint checking.** If `ContractRequirements.negotiableFields` is non-empty, the server MUST reject any `negotiationTerms` key that does not appear in `negotiableFields[*].field` (400). For fields that have `allowedValues`, the proposed value MUST be one of the listed strings (400). Fields absent from `negotiableFields` are not negotiable regardless of `negotiable: true`.

**Counter-offer.** When the server is willing to modify terms in response to a proposal — but not accept the proposal verbatim — it returns:

```json
{ "status": "counter_offer", "contractId": "<uuid>", "token": "",
  "counterOffer": { ...ContractRequirements } }
```

The client MAY inspect the counter-offer, optionally call `onNegotiation` again, and repost to `counterOffer.acceptEndpoint`. The reference `ContractClient` allows up to `maxNegotiationRounds` (default 3) round-trips before raising an error. A client that reaches the maximum round limit MUST NOT accept silently — it MUST surface an error.

---

## 8. Discovery

Servers SHOULD publish a discovery document at:

```
GET /.well-known/x490
```

Response type:

```typescript
export interface DiscoveryResource {
  resource: string;
  description: string;
  requirements: ContractRequirements;
}

export interface DiscoveryDocument {
  scheme: "x490";
  version: 1;
  origin: string;              // e.g. "https://api.example.com"
  resources: DiscoveryResource[];
}
```

Each entry includes the full `ContractRequirements` for the gated resource, enabling agents to pre-establish all required agreements in a single pass before issuing any resource requests. This is the agentic analogue of `/.well-known/oauth-authorization-server`.

---

## 9. Integration with x402

x402 (HTTP Payment Required) uses status code 402 and a payment challenge body. When a server requires both a legal agreement **and** payment, the 402 response body MAY embed an x490 requirement:

```typescript
export interface X402Response {
  x402Version: 1;
  accepts: X402PaymentRequirement[];
  contractRequired?: ContractRequirements;  // x490 extension
  error: string | null;
}
```

An x402-only client ignores the unknown `contractRequired` field. An x490-aware client MUST process the contract gate first: it calls `establishAgreement(body.contractRequired)`, caches the resulting token, then proceeds with x402 payment handling. On the authenticated retry the client attaches both `X-490-Contract` and the x402 payment header. Servers enforce both gates independently; either gate failing causes the appropriate challenge response (490 or 402).

---

## 10. Implementations

| Package | Language | Install |
|---|---|---|
| `@x490/protocol` | TypeScript / JavaScript | `npm install @x490/protocol` |
| `x490` | Python | `pip install x490` |

The TypeScript package exports `requireContract`, `acceptHandler`, `verifyHandler`, `revokeHandler`, `discoveryHandler` (Hono middleware/handlers), `ContractClient` (fetch wrapper), `signToken`/`verifyToken` (token primitives), and `InMemoryPendingContractStore`.

---

## 11. Security Considerations

**Token expiry.** Every `AgreementToken` carries `exp` (Unix seconds). Servers MUST reject expired tokens. The offer validity is set by `ContractRequirements.expiresIn`; implementations SHOULD choose the shortest TTL consistent with the use case. Clients MUST NOT cache tokens past their `exp`.

**Revocation.** Servers that need to invalidate agreements before expiry SHOULD expose `ContractRequirements.revokeEndpoint`. A `POST { contractId, reason? }` marks the contract revoked in a `RevocationStore`. The `requireContract` middleware checks the store on every request when one is provided. In facilitated mode, the facilitator's `verifyEndpoint` is responsible for reflecting revocation state.

**HMAC key rotation.** The HMAC secret is equivalent to an API key for the signing service. Operators SHOULD rotate secrets on a regular schedule and MUST rotate immediately on suspected compromise. Because tokens are self-contained and carry `exp`, short-lived tokens naturally limit the blast radius of a compromised secret — outstanding tokens expire on their own without a revocation store entry. Long-lived tokens require explicit revocation on rotation.

**Template integrity.** Clients MUST verify `templateHash` before accepting terms. A mismatch indicates either a substitution attack or an accidental stale URL. In either case the client MUST abort the flow.

**Constant-time comparison.** Signature verification MUST use constant-time byte comparison (§4.2) to prevent timing oracles.

**HTTPS.** All x490 endpoints (accept, verify, revoke, discovery) MUST be served over HTTPS in production. Transmitting tokens over plaintext HTTP exposes them to interception.
