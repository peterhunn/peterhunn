# @x490/protocol

[![npm version](https://img.shields.io/npm/v/@x490/protocol)](https://www.npmjs.com/package/@x490/protocol)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A machine-readable HTTP contracting protocol that lets servers gate resources behind signed, negotiable contract agreements and lets agents (or other clients) discover, accept, and carry those agreements automatically.

## Install

```sh
npm install @x490/protocol
```

Hono is an optional peer dependency — install it only when using the Hono middleware helpers:

```sh
npm install hono
```

## Quick start

### Server (Hono)

```typescript
import { Hono } from "hono";
import {
  requireContract,
  acceptHandler,
  discoveryHandler,
} from "@x490/protocol";

const requirements = {
  scheme: "x490" as const,
  version: 1 as const,
  templateId: "org.example.nda",
  templateUrl: "https://example.com/template",
  templateHash: "<sha256-of-template>",
  requiredPartyFields: ["name", "org"],
  acceptEndpoint: "https://api.example.com/accept",
  expiresIn: 86400,
  resource: "/data",
  description: "NDA required to access data",
  negotiable: false,
};

const SECRET = process.env.CONTRACT_SECRET!;

const app = new Hono();

app.get(
  "/.well-known/x490",
  discoveryHandler({
    origin: "https://api.example.com",
    resources: [{ resource: "/data", description: requirements.description, requirements }],
  }),
);

app.post("/accept", acceptHandler({ requirements, secret: SECRET }));

app.get(
  "/data",
  requireContract({ requirements, secret: SECRET }),
  (c) => c.json({ hello: c.var.x490PartyId }),
);
```

### Agent / Client

```typescript
import { ContractClient } from "@x490/protocol";

const client = new ContractClient({
  partyData: { name: "Acme Corp", org: "acme" },
});

// Automatically discovers the 490 gate, accepts the contract, and retries.
const res = await client.fetch("https://api.example.com/data");
const data = await res.json();
```

## Features

- **Negotiation** — servers advertise negotiable fields; clients propose terms and handle counter-offers
- **Multi-party** — `requiredParties > 1` tracks co-signers via `PendingContractStore` before issuing a token
- **Revocation** — `RevocationStore` integration in both `requireContract` and `verifyHandler`
- **x402 integration** — `buildX402WithContract` and `extractContractRequirements` for layered payment + contracting gates
- **Express + fetch adapters** — `requireContractFetch` for edge runtimes (Cloudflare Workers, Next.js middleware) and `requireContractExpress` for Express/Connect servers

## API Reference

### Client

| Export | Description |
|---|---|
| `ContractClient` | Fetch-compatible client that automatically traverses x490 and x402+x490 gates |

### Hono middleware

| Export | Description |
|---|---|
| `requireContract(opts)` | Hono middleware — gates a route, sets `c.var.x490ContractId` / `c.var.x490PartyId` |
| `acceptHandler(opts)` | Hono handler for the accept endpoint; handles negotiation and multi-party flows |
| `verifyHandler(opts)` | Hono handler for the facilitator verify endpoint |
| `revokeHandler(opts)` | Hono handler that marks a contract revoked in the store |
| `discoveryHandler(opts)` | Hono handler for `GET /.well-known/x490` — returns a `DiscoveryDocument` |

### Framework adapters

| Export | Description |
|---|---|
| `requireContractFetch(opts)` | Generic fetch-API adapter for edge runtimes and Cloudflare Workers |
| `requireContractExpress(opts)` | Express/Connect middleware adapter; sets `req.x490ContractId` / `req.x490PartyId` |

### Token utilities

| Export | Description |
|---|---|
| `signToken(payload, secret)` | Signs an `AgreementPayload` with HMAC-SHA256 and returns a compact token |
| `verifyToken(raw, secret, resource)` | Verifies a token and returns `VerifyOk` or `VerifyFail` |
| `decodeToken(raw)` | Decodes a token without verifying the signature |

### Stores

| Export | Description |
|---|---|
| `InMemoryRevocationStore` | In-memory `RevocationStore` — suitable for single-process servers and tests |
| `InMemoryPendingContractStore` | In-memory `PendingContractStore` for multi-party co-signing flows |

### x402 helpers

| Export | Description |
|---|---|
| `buildX402WithContract(paymentRequirements, contractRequirements)` | Builds an x402 response body that also embeds an x490 contract requirement |
| `extractContractRequirements(x402Response)` | Extracts the embedded `ContractRequirements` from an x402 response body |

## Full example

See [`packages/examples/src/x490-demo.ts`](../examples/src/x490-demo.ts) for a complete runnable demo covering server setup, agent client, negotiation, and revocation.
