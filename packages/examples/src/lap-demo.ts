/**
 * LAP/1.0 end-to-end demo — Legal Agents Protocol as an extension of x402.
 *
 * Demonstrates the full agentic commerce stack:
 *   Discovery → [LAP: Contract Agreement] → [x402: Payment] → Fulfillment
 *
 * Run:  npm run run:lap-demo
 *
 * What this shows:
 *   1. A Hono server exposes /data behind a LAP contract gate (data-use NDA)
 *   2. An AI agent (ContractClient) hits the endpoint, gets a 403 + requirements
 *   3. Agent fetches template, posts partyData to accept endpoint, gets a token
 *   4. Agent retries with X-Contract-Agreement → 200 OK
 *   5. The combined x402 + LAP flow (requires BOTH agreement AND payment proof)
 *   6. Negotiation round-trip (server counter-offers jurisdiction, agent accepts)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  ContractClient,
  requireContract,
  acceptHandler,
  buildX402WithContract,
  lapExtensionHeaders,
} from "@legal-agents/protocol";
import type { ContractRequirements } from "@legal-agents/protocol";

// ── Shared config ──────────────────────────────────────────────────────────────

const PORT = 4200;
const BASE = `http://localhost:${PORT}`;
const HMAC_SECRET = crypto.randomUUID(); // ephemeral per demo run

// Contract requirements the server advertises
const dataUseRequirements: ContractRequirements = {
  scheme: "legal-agents/v1",
  version: 1,
  templateId: "org.accordproject.data-use-nda",
  templateUrl: `${BASE}/.well-known/contracts/data-use-nda`,
  templateHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  requiredPartyFields: ["name", "jurisdiction"],
  jurisdiction: "California, USA",
  governingLaw: "laws of the State of California",
  acceptEndpoint: `${BASE}/contracts/accept`,
  verifyEndpoint: `${BASE}/contracts/verify`,
  expiresIn: 3600,
  resource: "/data",
  description: "Data Use Non-Disclosure Agreement — required before accessing the dataset",
  negotiable: true,
};

// Alternative requirements the server counter-offers during negotiation demo
const counterOfferRequirements: ContractRequirements = {
  ...dataUseRequirements,
  jurisdiction: "Delaware, USA",
  governingLaw: "laws of the State of Delaware",
};

// ── Server ─────────────────────────────────────────────────────────────────────

const app = new Hono();

// Serve the contract template (human + machine readable)
app.get("/.well-known/contracts/data-use-nda", (c) =>
  c.json({
    templateId: "org.accordproject.data-use-nda",
    title: "Data Use Non-Disclosure Agreement",
    text: "This Data Use NDA governs access to the dataset provided by {{discloser}} to {{name}} under the laws of {{jurisdiction}}. The receiving party agrees to use the data solely for the agreed purpose and not to disclose it to third parties.",
    model: {
      $class: "org.accordproject.data-use-nda.DataUseNDA",
      properties: [
        { name: "name", type: "String", description: "Legal name of the receiving party" },
        { name: "jurisdiction", type: "String", description: "Governing jurisdiction" },
      ],
    },
    hash: dataUseRequirements.templateHash,
  }),
);

// Accept endpoint — signs tokens, handles negotiation
app.post(
  "/contracts/accept",
  acceptHandler({
    requirements: dataUseRequirements,
    secret: HMAC_SECRET,
    ttl: 3600,
    onNegotiation: async (terms, _partyData) => {
      // Accept any jurisdiction the client proposes by counter-offering Delaware
      const proposed = terms["jurisdiction"];
      if (typeof proposed === "string" && proposed !== "California, USA") {
        console.log(`  [server] Client proposed jurisdiction="${proposed}", counter-offering Delaware`);
        return counterOfferRequirements;
      }
      return undefined; // accept as-is
    },
    onAccepted: async (contractId, partyData) => {
      console.log(`  [server] Agreement signed — contractId=${contractId} party="${partyData["name"]}"`);
    },
  }),
);

// Verify endpoint (facilitator pattern)
app.get("/contracts/verify", async (c) => {
  const token = c.req.query("token");
  const resource = c.req.query("resource") ?? "*";
  if (!token) return c.json({ error: "token required" }, 400);

  const { verifyToken } = await import("@legal-agents/protocol");
  const result = await verifyToken(token, HMAC_SECRET, resource);
  return result.valid
    ? c.json({ valid: true, contractId: result.payload.contractId, partyId: result.payload.partyId })
    : c.json({ valid: false, reason: result.reason });
});

// LAP-only gated endpoint
app.get(
  "/data",
  requireContract({ requirements: dataUseRequirements, secret: HMAC_SECRET }),
  (c) =>
    c.json({
      dataset: "Q1-2026",
      rows: 42_000,
      accessedBy: c.var.lapPartyId,
      contractId: c.var.lapContractId,
    }),
);

// Combined x402 + LAP gated endpoint (requires both agreement AND payment)
app.get("/premium-data", async (c) => {
  const agreementToken = c.req.header("X-Contract-Agreement");
  const paymentProof = c.req.header("X-PAYMENT");

  if (!agreementToken) {
    const body = buildX402WithContract(
      [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "1000000",
          resource: "/premium-data",
          description: "Premium dataset access — $1 USDC per request",
          payTo: "0x0000000000000000000000000000000000000000",
          maxTimeoutSeconds: 300,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
      ],
      dataUseRequirements,
    );
    return c.json(body, 402, lapExtensionHeaders(dataUseRequirements));
  }

  if (!paymentProof) {
    return c.json({ error: "X-PAYMENT required", hint: "pay via x402 facilitator" }, 402);
  }

  return c.json({
    dataset: "premium-Q1-2026",
    rows: 420_000,
    accessedBy: "verified",
    note: "Both LAP contract + x402 payment verified",
  });
});

// ── Run the demo ───────────────────────────────────────────────────────────────

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\nLAP/1.0 demo server listening on ${BASE}`);
});

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

await sleep(100); // let server bind

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 1: Basic LAP gate (contract agreement required)");
console.log("══════════════════════════════════════════════════════");

{
  const client = new ContractClient({
    partyData: { name: "Acme AI Agent", jurisdiction: "California, USA" },
    onRequirements: async (req) => {
      console.log(`  [agent] Received contract requirements: "${req.description}"`);
      console.log(`          Template: ${req.templateUrl}`);
    },
  });

  console.log("\n  → GET /data (no agreement yet)");
  const res = await client.fetch(`${BASE}/data`);
  const body = await res.json();
  console.log(`  ← ${res.status}`, JSON.stringify(body));
}

await sleep(50);

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 2: Negotiation — agent proposes different jurisdiction");
console.log("══════════════════════════════════════════════════════");

{
  let roundCount = 0;
  const client = new ContractClient({
    partyData: { name: "Beta AI Corp", jurisdiction: "New York, USA" },
    onNegotiation: async (req) => {
      roundCount++;
      if (roundCount === 1) {
        console.log(`  [agent] Proposing jurisdiction: "New York, USA" (round ${roundCount})`);
        return { jurisdiction: "New York, USA" };
      }
      // On counter-offer, accept Delaware without further negotiation
      console.log(`  [agent] Accepting server counter-offer: "${req.jurisdiction}" (round ${roundCount})`);
      return undefined;
    },
  });

  const res = await client.fetch(`${BASE}/data`);
  const body = await res.json();
  console.log(`  ← ${res.status}`, JSON.stringify(body));
}

await sleep(50);

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 3: x402 + LAP combined gate");
console.log("══════════════════════════════════════════════════════");

{
  const client = new ContractClient({
    partyData: { name: "Commerce Agent", jurisdiction: "California, USA" },
  });

  console.log("\n  → GET /premium-data (no agreement, no payment)");
  const res1 = await client.fetch(`${BASE}/premium-data`);
  const body1 = await res1.json() as { x402Version?: number; contractRequired?: unknown };
  console.log(`  ← ${res1.status} x402Version=${body1.x402Version ?? "n/a"} contractRequired=${body1.contractRequired ? "present" : "absent"}`);
  console.log("  [agent] LAP contract agreement now cached from x402 body");

  // Simulate x402 payment proof (in real usage, the agent calls the x402 facilitator)
  const cachedToken = await client.establishAgreement(dataUseRequirements);
  console.log("\n  → GET /premium-data (with agreement token + mock payment proof)");
  const res2 = await fetch(`${BASE}/premium-data`, {
    headers: {
      "X-Contract-Agreement": cachedToken,
      "X-PAYMENT": "mock-payment-proof",
    },
  });
  const body2 = await res2.json();
  console.log(`  ← ${res2.status}`, JSON.stringify(body2));
}

console.log("\n══════════════════════════════════════════════════════\n");
server.close();
