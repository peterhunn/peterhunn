/**
 * x490 facilitator demo — managed service integration.
 *
 * Shows the clean separation between open protocol and managed service:
 *
 *   Protocol (@x490/protocol):  types, middleware, ContractClient — open, self-hostable
 *   Managed service (@x490/facilitator): hosted token issuance, template registry,
 *                                         agreement tracking — the product
 *
 * Run:  npm run run:facilitator-demo
 *
 * What this shows:
 *   1. Server operator signs up → gets tenantId + apiKey
 *   2. Operator registers a template → gets a content-addressed hash + hosted URL
 *   3. Operator fetches ContractRequirements with facilitator endpoints pre-filled
 *   4. Operator mounts requireContract({ requirements, facilitated: true }) — no secret
 *   5. AI agent hits the gated endpoint → auto-traverses → 200 OK
 *   6. Operator lists agreements from the facilitator dashboard
 *   7. Operator revokes → agent token rejected
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createFacilitatorApp,
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  FacilitatorClient,
  signUp,
} from "@x490/facilitator";
import { requireContract, ContractClient } from "@x490/protocol";
import type { ContractRequirements } from "@x490/protocol";

// ── Start the facilitator service ──────────────────────────────────────────────

const FACILITATOR_PORT = 4902;
const FACILITATOR_BASE = `http://localhost:${FACILITATOR_PORT}`;

const facilitatorApp = createFacilitatorApp({
  tenants: new InMemoryTenantStore(),
  templates: new InMemoryTemplateStore(),
  agreements: new InMemoryAgreementStore(),
  baseUrl: FACILITATOR_BASE,
});

const facilitatorServer = serve({ fetch: facilitatorApp.fetch, port: FACILITATOR_PORT });
await new Promise((r) => setTimeout(r, 100));

// ── Start the server operator's API ───────────────────────────────────────────

const API_PORT = 4903;
const API_BASE = `http://localhost:${API_PORT}`;

// requirements is set after operator registration (below)
let requirements!: ContractRequirements;

const apiApp = new Hono();
apiApp.get(
  "/data",
  // facilitated: true → no secret, verification delegated to facilitator
  (c, next) => requireContract({ requirements, facilitated: true })(c, next),
  (c) => c.json({ rows: 42_000, accessedBy: c.var.x490PartyId }),
);

const apiServer = serve({ fetch: apiApp.fetch, port: API_PORT });
await new Promise((r) => setTimeout(r, 100));

console.log("\nx490 facilitator demo\n");

// ── Demo 1: Operator sign-up ───────────────────────────────────────────────────

console.log("══════════════════════════════════════════════════════");
console.log("  Step 1: Server operator signs up");
console.log("══════════════════════════════════════════════════════\n");

const { tenantId, apiKey } = await signUp("Acme Data Co.", FACILITATOR_BASE);
console.log(`  tenantId: ${tenantId}`);
console.log(`  apiKey:   ${apiKey.slice(0, 18)}... (store securely — shown once)`);

const facilitator = new FacilitatorClient({ apiKey, tenantId, baseUrl: FACILITATOR_BASE });

// ── Demo 2: Register template ──────────────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════");
console.log("  Step 2: Register a contract template");
console.log("══════════════════════════════════════════════════════\n");

const ndaText = `This Data Use Non-Disclosure Agreement is entered into between Acme Data Co. (the "Discloser") and {{name}} (the "Recipient") under the laws of {{jurisdiction}}. The Recipient agrees to keep all data confidential.`;

const { hash, url } = await facilitator.uploadTemplate(ndaText, {
  title: "Data Use NDA",
  description: "Required before accessing the dataset",
});
console.log(`  template hash: ${hash.slice(0, 16)}...`);
console.log(`  hosted at:     ${url}`);

// ── Demo 3: Build ContractRequirements ────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════");
console.log("  Step 3: Build ContractRequirements");
console.log("══════════════════════════════════════════════════════\n");

requirements = await facilitator.buildRequirements({
  templateHash: hash,
  requiredPartyFields: ["name", "jurisdiction"],
  resource: "/data",
  description: "Data Use NDA — required before accessing the dataset",
  expiresIn: 3600,
  negotiable: false,
});

console.log(`  acceptEndpoint: ${requirements.acceptEndpoint}`);
console.log(`  verifyEndpoint: ${requirements.verifyEndpoint}`);
console.log(`  revokeEndpoint: ${requirements.revokeEndpoint}`);
console.log(`  (no HMAC secret on the server — facilitator holds all key material)`);

// ── Demo 4: Agent traverses the gate ──────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════");
console.log("  Step 4: AI agent accesses the gated resource");
console.log("══════════════════════════════════════════════════════\n");

const client = new ContractClient({
  partyData: { name: "Research AI Agent", jurisdiction: "California, USA" },
  onRequirements: async (req) => {
    console.log(`  [agent] 490 received: "${req.description}"`);
    console.log(`          Fetching template from ${req.templateUrl}`);
  },
});

console.log("  → GET /data (no X-490-Contract)");
const res = await client.fetch(`${API_BASE}/data`);
const body = await res.json();
console.log(`  ← ${res.status}`, JSON.stringify(body));

// ── Demo 5: Operator views agreements ─────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════");
console.log("  Step 5: Operator reviews the agreement dashboard");
console.log("══════════════════════════════════════════════════════\n");

const agreements = await facilitator.listAgreements({ resource: "/data" });
console.log(`  ${agreements.length} agreement(s) for /data:`);
for (const a of agreements) {
  console.log(`  • contractId=${a.contractId}`);
  console.log(`    party=${a.partyId}  expires=${new Date(a.expiresAt * 1000).toISOString()}`);
}

// ── Demo 6: Revocation ────────────────────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════");
console.log("  Step 6: Operator revokes — agent token rejected");
console.log("══════════════════════════════════════════════════════\n");

const [agreement] = agreements;
if (agreement) {
  await facilitator.revokeAgreement(agreement.contractId, "Demo revocation");
  console.log(`  revoked contractId=${agreement.contractId}`);

  // Agent retries with the now-revoked token (client re-uses its cached token)
  console.log("\n  → GET /data (cached token, now revoked)");
  const res2 = await fetch(`${API_BASE}/data`, {
    headers: { "X-490-Contract": agreement.contractId }, // contractId ≠ token, but agent has the token cached
  });
  // Use the agent's internal cache to get the token
  const cachedToken = await (client as unknown as { findCachedToken: (r: string) => string | undefined }).findCachedToken?.("/data");
  const retryHeaders: Record<string, string> = {};
  if (cachedToken) retryHeaders["X-490-Contract"] = cachedToken;

  const res3 = await fetch(`${API_BASE}/data`, { headers: retryHeaders });
  const body3 = await res3.json() as { error?: string };
  console.log(`  ← ${res3.status} error="${body3.error ?? "none"}"`);
}

console.log("\n══════════════════════════════════════════════════════\n");
facilitatorServer.close();
apiServer.close();
