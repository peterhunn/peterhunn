/**
 * x490 end-to-end demo — Legal contracting protocol extending x402.
 *
 * Demonstrates the full agentic commerce stack:
 *   Discovery → [x490: Contract Agreement] → [x402: Payment] → Fulfillment
 *
 * Run:  npm run run:x490-demo
 *
 * What this shows:
 *   1. Basic 490 gate — agent auto-traverses, retries with X-490-Contract token
 *   2. Structured negotiation using negotiableFields
 *   2b. Rejected proposal (non-negotiable field)
 *   3. Combined x402 + x490 gate
 *   4. /.well-known/x490 discovery document
 *   5. Token revocation — issued token rejected after revokeEndpoint call
 *   6. Multi-party acceptance — two parties co-sign before token is issued
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  ContractClient,
  requireContract,
  acceptHandler,
  buildX402WithContract,
  x490ExtensionHeaders,
  revokeHandler,
  discoveryHandler,
  InMemoryRevocationStore,
  InMemoryPendingContractStore,
} from "@x490/protocol";
import type { ContractRequirements } from "@x490/protocol";

// ── Shared config ──────────────────────────────────────────────────────────────

const PORT = 4900;
const BASE = `http://localhost:${PORT}`;
const HMAC_SECRET = crypto.randomUUID(); // ephemeral per demo run

const revocationStore = new InMemoryRevocationStore();
const pendingStore = new InMemoryPendingContractStore();

const dataUseRequirements: ContractRequirements = {
  scheme: "x490",
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

const ndaRequirements: ContractRequirements = {
  ...dataUseRequirements,
  resource: "/nda-data",
  acceptEndpoint: `${BASE}/nda/accept`,
  revokeEndpoint: `${BASE}/nda/revoke`,
  description: "Bilateral NDA — revocable by either party",
};

const multiPartyRequirements: ContractRequirements = {
  ...dataUseRequirements,
  resource: "/joint-data",
  acceptEndpoint: `${BASE}/joint/accept`,
  requiredParties: 2,
  description: "Joint venture agreement — requires sign-off from both parties",
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
  const { verifyToken } = await import("@x490/protocol");
  const result = await verifyToken(token, HMAC_SECRET, resource);
  return result.valid
    ? c.json({ valid: true, contractId: result.payload.contractId, partyId: result.payload.partyId })
    : c.json({ valid: false, reason: result.reason });
});

// x490-gated endpoint — returns 490 until agreement token is present
app.get(
  "/data",
  requireContract({ requirements: dataUseRequirements, secret: HMAC_SECRET }),
  (c) =>
    c.json({
      dataset: "Q1-2026",
      rows: 42_000,
      accessedBy: c.var.x490PartyId,
      contractId: c.var.x490ContractId,
    }),
);

// Combined x402 + x490 endpoint — requires both agreement AND payment
app.get("/premium-data", async (c) => {
  const agreementToken = c.req.header("X-490-Contract");
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
    return c.json(body, 402, x490ExtensionHeaders(dataUseRequirements));
  }

  if (!paymentProof) {
    return c.json({ error: "X-PAYMENT required" }, 402);
  }

  return c.json({
    dataset: "premium-Q1-2026",
    rows: 420_000,
    note: "Both x490 contract + x402 payment verified",
  });
});

// ── Discovery ─────────────────────────────────────────────────────────────────

app.get(
  "/.well-known/x490",
  discoveryHandler({
    origin: BASE,
    resources: [
      { resource: "/data", description: dataUseRequirements.description, requirements: dataUseRequirements },
      { resource: "/nda-data", description: ndaRequirements.description, requirements: ndaRequirements },
      { resource: "/joint-data", description: multiPartyRequirements.description, requirements: multiPartyRequirements },
    ],
  }),
);

// ── Revocable NDA endpoint ─────────────────────────────────────────────────────

app.post(
  "/nda/accept",
  acceptHandler({
    requirements: ndaRequirements,
    secret: HMAC_SECRET,
    onAccepted: async (contractId, partyData) => {
      console.log(`  [server] NDA signed — contractId=${contractId} party="${partyData["name"]}"`);
    },
  }),
);

app.post(
  "/nda/revoke",
  revokeHandler({
    revocationStore,
    onRevoke: async (contractId, reason) => {
      console.log(`  [server] Revoke requested — contractId=${contractId} reason="${reason ?? "none"}"`);
      return true; // allow all revocations in this demo
    },
  }),
);

app.get(
  "/nda-data",
  requireContract({ requirements: ndaRequirements, secret: HMAC_SECRET, revocationStore }),
  (c) => c.json({ secret: "NDA-protected data", contractId: c.var.x490ContractId }),
);

// ── Multi-party joint venture endpoint ────────────────────────────────────────

app.post(
  "/joint/accept",
  acceptHandler({
    requirements: multiPartyRequirements,
    secret: HMAC_SECRET,
    pendingStore,
    onAccepted: async (contractId, partyData) => {
      console.log(`  [server] Joint contract complete — contractId=${contractId} final party="${partyData["name"]}"`);
    },
  }),
);

app.get(
  "/joint-data",
  requireContract({ requirements: multiPartyRequirements, secret: HMAC_SECRET }),
  (c) => c.json({ joint: "venture data", contractId: c.var.x490ContractId }),
);

// ── Run the demo ───────────────────────────────────────────────────────────────

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\nx490 demo server listening on ${BASE}`);
});

await new Promise((r) => setTimeout(r, 100));

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 1: x490 gate (490 Contract Required)");
console.log("══════════════════════════════════════════════════════");

{
  const client = new ContractClient({
    partyData: { name: "Acme AI Agent", jurisdiction: "California, USA" },
    onRequirements: async (req) => {
      console.log(`  [agent] 490 received: "${req.description}"`);
      console.log(`          Template: ${req.templateUrl}`);
    },
  });

  console.log("\n  → GET /data (no X-490-Contract)");
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
console.log("  Demo 3: x402 + x490 combined gate");
console.log("══════════════════════════════════════════════════════");

{
  const client = new ContractClient({
    partyData: { name: "Commerce Agent", jurisdiction: "California, USA" },
  });

  console.log("\n  → GET /premium-data (no agreement, no payment)");
  const res1 = await client.fetch(`${BASE}/premium-data`);
  const body1 = await res1.json() as { x402Version?: number; contractRequired?: unknown };
  console.log(`  ← ${res1.status} x402Version=${body1.x402Version ?? "n/a"} contractRequired=${body1.contractRequired ? "present" : "absent"}`);
  console.log("  [agent] x490 token cached from 402 body; caller now handles x402 payment");

  const cachedToken = await client.establishAgreement(dataUseRequirements);
  console.log("\n  → GET /premium-data (X-490-Contract + mock X-PAYMENT)");
  const res2 = await fetch(`${BASE}/premium-data`, {
    headers: {
      "X-490-Contract": cachedToken,
      "X-PAYMENT": "mock-payment-proof",
    },
  });
  const body2 = await res2.json();
  console.log(`  ← ${res2.status}`, JSON.stringify(body2));
}

await new Promise((r) => setTimeout(r, 50));

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 4: /.well-known/x490 discovery document");
console.log("══════════════════════════════════════════════════════");

{
  console.log("\n  → GET /.well-known/x490");
  const res = await fetch(`${BASE}/.well-known/x490`);
  const doc = await res.json() as { scheme: string; version: number; resources: Array<{ resource: string; description: string }> };
  console.log(`  ← ${res.status} scheme=${doc.scheme} version=${doc.version}`);
  console.log(`  [agent] Server advertises ${doc.resources.length} contract-gated resource(s):`);
  for (const r of doc.resources) {
    console.log(`          • ${r.resource} — "${r.description}"`);
  }
}

await new Promise((r) => setTimeout(r, 50));

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 5: Token revocation");
console.log("══════════════════════════════════════════════════════");

{
  // Accept the NDA to get a token
  console.log("\n  → POST /nda/accept (get a token)");
  const acceptRes = await fetch(`${BASE}/nda/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId: ndaRequirements.templateId,
      templateHash: ndaRequirements.templateHash,
      partyData: { name: "Revocable Agent", jurisdiction: "California, USA" },
    }),
  });
  const accepted = await acceptRes.json() as { status: string; contractId: string; token: string };
  console.log(`  ← ${acceptRes.status} status=${accepted.status} contractId=${accepted.contractId}`);

  // Use the token — should work
  console.log("\n  → GET /nda-data (with valid token)");
  const res1 = await fetch(`${BASE}/nda-data`, {
    headers: { "X-490-Contract": accepted.token },
  });
  const body1 = await res1.json();
  console.log(`  ← ${res1.status}`, JSON.stringify(body1));

  // Revoke the contract
  console.log("\n  → POST /nda/revoke");
  const revokeRes = await fetch(`${BASE}/nda/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contractId: accepted.contractId, reason: "Terms violation" }),
  });
  const revokeBody = await revokeRes.json();
  console.log(`  ← ${revokeRes.status}`, JSON.stringify(revokeBody));

  // Try again — should now be rejected
  console.log("\n  → GET /nda-data (same token, now revoked)");
  const res2 = await fetch(`${BASE}/nda-data`, {
    headers: { "X-490-Contract": accepted.token },
  });
  const body2 = await res2.json() as { error?: string };
  console.log(`  ← ${res2.status} error="${body2.error}"`);
}

await new Promise((r) => setTimeout(r, 50));

console.log("\n══════════════════════════════════════════════════════");
console.log("  Demo 6: Multi-party acceptance (2-of-2 co-signing)");
console.log("══════════════════════════════════════════════════════");

{
  // Party A signs first
  console.log("\n  → POST /joint/accept (Party A — first signer)");
  const res1 = await fetch(`${BASE}/joint/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId: multiPartyRequirements.templateId,
      templateHash: multiPartyRequirements.templateHash,
      partyData: { name: "Party A", jurisdiction: "California, USA" },
    }),
  });
  const body1 = await res1.json() as { status: string; contractId: string; pendingAcceptances: number; requiredAcceptances: number };
  console.log(`  ← ${res1.status} status=${body1.status} accepted=${body1.pendingAcceptances}/${body1.requiredAcceptances} contractId=${body1.contractId}`);

  // Party B co-signs using pendingContractId
  console.log("\n  → POST /joint/accept (Party B — co-signer, pendingContractId provided)");
  const res2 = await fetch(`${BASE}/joint/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId: multiPartyRequirements.templateId,
      templateHash: multiPartyRequirements.templateHash,
      partyData: { name: "Party B", jurisdiction: "California, USA" },
      pendingContractId: body1.contractId,
    }),
  });
  const body2 = await res2.json() as { status: string; contractId: string; token: string };
  console.log(`  ← ${res2.status} status=${body2.status} contractId=${body2.contractId}`);

  if (body2.status === "accepted" && body2.token) {
    // Use the jointly-signed token
    console.log("\n  → GET /joint-data (with jointly-signed token)");
    const res3 = await fetch(`${BASE}/joint-data`, {
      headers: { "X-490-Contract": body2.token },
    });
    const body3 = await res3.json();
    console.log(`  ← ${res3.status}`, JSON.stringify(body3));
  }
}

console.log("\n══════════════════════════════════════════════════════\n");
server.close();
