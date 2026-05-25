# @x490/x402

Server middleware and client for the [x402 HTTP payment protocol](https://x402.org) — compatible with the Coinbase/Base x402 spec.

## What is x402?

x402 layers machine-readable payment negotiation on top of HTTP 402 Payment Required:

1. Client requests a resource
2. Server returns `402` with `X-Payment-Required: <base64url(PaymentRequirements)>`
3. Client creates an EIP-3009 signed authorization and retries with `X-Payment: <base64url(PaymentProof)>`
4. Server verifies the payment and returns the resource

## Install

```sh
npm install @x490/x402
```

## Server middleware (Hono)

```ts
import { Hono } from "hono";
import { requirePayment } from "@x490/x402";
import type { PaymentRequirements } from "@x490/x402";

const requirements: PaymentRequirements = {
  version: 1,
  scheme: "exact",
  network: "base",
  maxAmountRequired: "1000000",   // 1 USDC (6 decimals)
  resource: "/api/data",
  description: "Access to premium data",
  payTo: "0xYourWalletAddress",
  maxTimeoutSeconds: 60,
  asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC on Base
  extra: { name: "USDC", decimals: 6 },
};

const app = new Hono();

app.get(
  "/api/data",
  requirePayment({ requirements }),
  (c) => c.json({ answer: 42 }),
);
```

## Client

```ts
import { X402Client } from "@x490/x402";

const client = new X402Client({
  // Replace with your wallet signing logic
  pay: async (requirements) => ({
    x402Version: 1,
    scheme: "exact",
    network: requirements.network,
    payload: {
      signature: await wallet.signAuthorization(requirements),
      authorization: {
        from: wallet.address,
        to: requirements.payTo,
        value: requirements.maxAmountRequired,
        validAfter: String(Math.floor(Date.now() / 1000) - 10),
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: crypto.randomUUID().replace(/-/g, ""),
      },
    },
  }),
});

const res = await client.fetch("https://api.example.com/api/data");
const data = await res.json();
```

The client automatically handles 402 responses: it calls `pay()` with the server's requirements, then retries the request with the payment proof attached.

## Offline vs on-chain verification

The default verifier (`verifyPaymentOffline`) checks proof structure and basic constraints — recipient address, amount, network, signature format, and expiry — without hitting the blockchain. This is useful for testing and low-value endpoints.

For production, supply a custom `verify` function that settles the EIP-3009 `transferWithAuthorization` on-chain:

```ts
app.get(
  "/api/data",
  requirePayment({
    requirements,
    verify: async (proof, requirements) => {
      // Call your on-chain verifier / Coinbase x402 facilitator here
      return myOnChainVerifier(proof, requirements);
    },
  }),
  (c) => c.json({ answer: 42 }),
);
```

## Codec helpers

```ts
import { encodeRequirements, decodeRequirements, encodeProof, decodeProof } from "@x490/x402";

const encoded = encodeRequirements(requirements); // base64url string
const decoded = decodeRequirements(encoded);      // PaymentRequirements
```
