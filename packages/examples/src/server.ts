/**
 * Example server — NDA registered, auth + party signing + obligation executor enabled.
 *
 * Run:  ANTHROPIC_API_KEY=sk-... npm run run:server
 *
 * On startup, three keys are printed:
 *   ADMIN_KEY   — full access, no party binding
 *   ACME_KEY    — bound to the disclosing party (partyId: "acme")
 *   BETA_KEY    — bound to the receiving party  (partyId: "beta")
 *
 * Agent-style usage:
 *   # Acme's agent activates the NDA (admin key, or any key)
 *   curl -X POST http://localhost:3000/contracts/nda/activate \
 *     -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
 *     -d '{ "data": { "$class": "org.accordproject.nda.NDAContract",
 *       "disclosingParty": { "$class": "org.accordproject.party.Party", "partyId": "acme", "name": "Acme Corp" },
 *       "receivingParty": { "$class": "org.accordproject.party.Party", "partyId": "beta", "name": "Beta Inc" },
 *       "effectiveDate": "2026-01-15", "durationMonths": 24,
 *       "jurisdiction": "San Francisco, CA", "governingLaw": "laws of the State of California",
 *       "confidentialInfo": "technical specs and financials", "mutual": false } }'
 *
 *   # Acme's agent discloses — party is inferred from the key, no "party" field needed
 *   curl -X POST "http://localhost:3000/contracts/$CONTRACT_ID/events" \
 *     -H "Authorization: Bearer $ACME_KEY" -H "Content-Type: application/json" \
 *     -d '{ "eventType": "DISCLOSURE_MADE", "payload": { "description": "Q1 roadmap" } }'
 *
 *   # Beta's agent acknowledges — again, party comes from the key
 *   curl -X POST "http://localhost:3000/contracts/$CONTRACT_ID/events" \
 *     -H "Authorization: Bearer $BETA_KEY" -H "Content-Type: application/json" \
 *     -d '{ "eventType": "DISCLOSURE_MADE", "payload": { "description": "acknowledged" } }'
 *
 *   # Verify the Merkle DAG audit log
 *   curl -H "Authorization: Bearer $ADMIN_KEY" \
 *     "http://localhost:3000/contracts/$CONTRACT_ID/audit/verify"
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@x490/agents";
import {
  ContractRegistry,
  InMemoryApiKeyStore,
  startServer,
} from "@x490/api";
import { ndaModel } from "./nda/model.js";
import { ndaTemplate } from "./nda/template.js";
import { ndaLogic } from "./nda/logic.js";

const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");

const llm = new AnthropicClient(
  new Anthropic({ apiKey: anthropicApiKey }),
  "claude-opus-4-7",
);

const registry = new ContractRegistry().register("nda", {
  model: ndaModel,
  template: ndaTemplate,
  logic: ndaLogic,
});

// Bootstrap: create three keys for this session.
// In production: persist these in Postgres via PostgresApiKeyStore.
const apiKeys = new InMemoryApiKeyStore();
const [{ raw: adminKey }, { raw: acmeKey }, { raw: betaKey }] =
  await Promise.all([
    apiKeys.create("org-default", "admin",       "live"),
    apiKeys.create("org-default", "acme-agent",  "live", "acme"),
    apiKeys.create("org-default", "beta-agent",  "live", "beta"),
  ]);

console.log("\n  Keys (shown once):");
console.log(`  ADMIN_KEY=${adminKey}`);
console.log(`  ACME_KEY=${acmeKey}   # party: acme (disclosing)`);
console.log(`  BETA_KEY=${betaKey}   # party: beta (receiving)\n`);

startServer({
  registry,
  llm,
  apiKeys,
  port: Number(process.env["PORT"] ?? 3000),
  executorIntervalMs: 30_000,   // check every 30 s in this demo
});
