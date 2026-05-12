/**
 * x451 end-to-end demo — Legal contracting protocol extending x402.
 *
 * Demonstrates the full agentic commerce stack:
 *   Discovery → [x451: Contract Agreement] → [x402: Payment] → Fulfillment
 *
 * Run:  npm run run:x451-demo
 *
 * What this shows:
 *   1. A Hono server exposes /data behind an x451 contract gate (data-use NDA)
 *   2. An AI agent (ContractClient) hits the endpoint, gets 451 + X-451-Requirements
 *   3. Agent fetches template, posts partyData to accept endpoint, gets X-451-Contract token
 *   4. Agent retries with X-451-Contract → 200 OK
 *   5. The combined x402 + x451 flow (requires BOTH agreement AND payment proof)
 *   6. Negotiation round-trip (server counter-offers jurisdiction, agent accepts)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  ContractClient,
  requireContract,
  acceptHandler,
  buildX402WithContract,
  x451ExtensionHeaders,
} from "@legal-agents/protocol";
import type { ContractRequirements } from "@legal-agents/protocol";

// ── Shared config ──────────────────────────────────────────────────────────────

const PORT = 4510;
const BASE = `http://localhost:${PORT}`;
const HMAC_SECRET = crypto.randomUUID(); // ephemeral per demo run

const dataUseRequirements: ContractRequirements = {
  scheme: "x451",
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
  description: "Data Use NDA — required before accessing the dataset",
  negotiable: true,
  negotiableFields: [
    {
      field: "jurisdiction",
      allowedValues: ["California, USA", "Delaware, USA", "New York, USA"],
      description: "Governing jurisdiction for dispute resolution. Delaware preferred for corporate entities.",
    },
    {
      field: "expiresIn",
      allowedValues: ["3600", "86400", "2592000"],
      description: "Token validity in seconds: 1 hour, 1 day, or 30 days.",
    },
  ],
};

const counterOfferRequirements: ContractRequirements = {
  ...dataUseRequirements,
  jurisdiction: "Delaware, USA",
  governingLaw: "laws of the State of Delaware",
};

// ── Server ─────────────────────────────────────────────────────────────────────

const app = new Hono();

app.get("/.well-known/contracts/data-use-nda", (c) =>
  c.json({
    templateId: "org.accordproject.data-use-nda",
    title: "Data Use Non-Disclosure Agreement",
    text: "This Data Use NDA governs access to the dataset provided by {{discloser}} to {{name}} under the laws of {{jurisdiction}}.",
    hash: dataUseRequirements.templateHash,
  }),
);

app.post(
  "/contracts/accept",
  acceptHandler({
    requirements: dataUseRequirements,
    secret: HMAC_SECRET,
    ttl: 3600,
    onNegotiation: async (terms, _partyData) => {
      const proposed = terms["jurisdiction"];
      if (typeof proposed === "string" && proposed !== "California, USA") {
        console.log(`  [server] Client proposed jurisdiction="${proposed}", counter-offering Delaware`);
        return counterOfferRequirements;
      }
      return undefined;
    },
    onAccepted: async (contractId, partyData) => {
      console.log(`  [server] Agreement signed — contractId=${contractId} party="${partyData["name"]}"`);
    },
  }),
);

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

// x451-gated endpoint — returns 451 until agreement token is present
app.get(
  "/data",
  requireContract({ requirements: dataUseRequirements, secret: HMAC_SECRET }),
  (c) =>
    c.json({
      dataset: "Q1-2026",
      rows: 42_000,
      accessedBy: c.var.x451PartyId,
      contractId: c.var.x451ContractId,
    }),
);

// Combined x402 + x451 endpoint — requires both agreement AND payment
app.get("/premium-data", async (c) => {
  const agreementToken = c.req.header("X-451-Contract");
  const paymentProof = c.req.header("X-PAYMENT");

  if (!agreementToken) {
    const body = buildX402WithContract(
      [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "1000000",
          resource: "/premium-data",
          description: "Premium dataset — $1 USDC per request",
          payTo: "0x0000000000000000000000000000000000000000",
          maxTimeoutSeconds: 300,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
      ],
      dataUseRequirements,
    );
    return c.json(body, 402, x451ExtensionHeaders(dataUseRequirements));
  }

  if (!paymentProof) {
    return c.json({ error: "X-PAYMENT required" }, 402);
  }

  return c.json({
    dataset: "premium-Q1-2026",
    rows: 420_000,
    note: "Both x451 contract + x402 payment verified",
  });
});

// ── Run the demo ───────────────────────────────────────────────────────────────

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\nx451 demo server listening on ${BASE}`);
});

await new Promise((r) => setTimeout(r, 100));

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 1: x451 gate (451 Contract Required)");
console.log("══════════════════════════════════════════════════════");

{
  const client = new ContractClient({
    partyData: { name: "Acme AI Agent", jurisdiction: "California, USA" },
    onRequirements: async (req) => {
      console.log(`  [agent] 451 received: "${req.description}"`);
      console.log(`          Template: ${req.templateUrl}`);
    },
  });

  console.log("\n  → GET /data (no X-451-Contract)");
  const res = await client.fetch(`${BASE}/data`);
  const body = await res.json();
  console.log(`  ← ${res.status}`, JSON.stringify(body));
}

await new Promise((r) => setTimeout(r, 50));

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 2: Structured negotiation using negotiableFields");
console.log("══════════════════════════════════════════════════════");

{
  let round = 0;
  const client = new ContractClient({
    partyData: { name: "Beta AI Corp", jurisdiction: "New York, USA" },
    onNegotiation: async (req) => {
      round++;
      const fields = req.negotiableFields ?? [];

      if (round === 1) {
        // Agent reads negotiableFields to discover what it can propose
        console.log(`  [agent] Server advertises ${fields.length} negotiable field(s):`);
        for (const f of fields) {
          console.log(`          • ${f.field}: ${f.description}`);
          if (f.allowedValues) console.log(`            allowed: ${f.allowedValues.join(", ")}`);
        }

        // Pick "New York, USA" — it's in the allowedValues list
        const jurisdictionField = fields.find((f) => f.field === "jurisdiction");
        const preferred = jurisdictionField?.allowedValues?.includes("New York, USA")
          ? "New York, USA"
          : jurisdictionField?.allowedValues?.[0];

        console.log(`  [agent] Proposing jurisdiction="${preferred}" (round ${round})`);
        return preferred ? { jurisdiction: preferred } : undefined;
      }

      // Server counter-offered; agent accepts Delaware
      console.log(`  [agent] Accepting counter-offer jurisdiction="${req.jurisdiction}" (round ${round})`);
      return undefined;
    },
  });

  const res = await client.fetch(`${BASE}/data`);
  const body = await res.json();
  console.log(`  ← ${res.status}`, JSON.stringify(body));
}

await new Promise((r) => setTimeout(r, 50));

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 2b: Rejected proposal (field not negotiable)");
console.log("══════════════════════════════════════════════════════");

{
  // Directly test the accept endpoint with a non-negotiable field
  console.log("\n  → POST /contracts/accept { negotiationTerms: { confidentialityPeriod: 12 } }");
  const res = await fetch(`${BASE}/contracts/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId: dataUseRequirements.templateId,
      templateHash: dataUseRequirements.templateHash,
      partyData: { name: "Rogue Agent", jurisdiction: "California, USA" },
      negotiationTerms: { confidentialityPeriod: 12 }, // not in negotiableFields
    }),
  });
  const body = await res.json();
  console.log(`  ← ${res.status}`, JSON.stringify(body));
}

await new Promise((r) => setTimeout(r, 50));

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 3: x402 + x451 combined gate");
console.log("══════════════════════════════════════════════════════");

{
  const client = new ContractClient({
    partyData: { name: "Commerce Agent", jurisdiction: "California, USA" },
  });

  console.log("\n  → GET /premium-data (no agreement, no payment)");
  const res1 = await client.fetch(`${BASE}/premium-data`);
  const body1 = await res1.json() as { x402Version?: number; contractRequired?: unknown };
  console.log(`  ← ${res1.status} x402Version=${body1.x402Version ?? "n/a"} contractRequired=${body1.contractRequired ? "present" : "absent"}`);
  console.log("  [agent] x451 token cached from 402 body; caller now handles x402 payment");

  const cachedToken = await client.establishAgreement(dataUseRequirements);
  console.log("\n  → GET /premium-data (X-451-Contract + mock X-PAYMENT)");
  const res2 = await fetch(`${BASE}/premium-data`, {
    headers: {
      "X-451-Contract": cachedToken,
      "X-PAYMENT": "mock-payment-proof",
    },
  });
  const body2 = await res2.json();
  console.log(`  ← ${res2.status}`, JSON.stringify(body2));
}

console.log("\n══════════════════════════════════════════════════════\n");
server.close();
