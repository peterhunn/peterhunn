/**
 * Example server — NDA registered, auth enabled, audit + webhooks wired.
 *
 * Run:  ANTHROPIC_API_KEY=sk-... npm run run:server
 *
 * On first start, an API key is created and printed. Use it in all requests:
 *   Authorization: Bearer sk_live_xxx
 *
 * Quick start:
 *
 *   # List contract types
 *   curl -H "Authorization: Bearer $KEY" http://localhost:3000/contracts
 *
 *   # Draft an NDA
 *   curl -X POST http://localhost:3000/contracts/nda/draft \
 *     -H "Authorization: Bearer $KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{ "data": { "$class": "org.accordproject.nda.NDAContract",
 *       "disclosingParty": { "$class": "org.accordproject.party.Party", "partyId": "acme", "name": "Acme Corp" },
 *       "receivingParty": { "$class": "org.accordproject.party.Party", "partyId": "beta", "name": "Beta Inc" },
 *       "effectiveDate": "2026-01-15", "durationMonths": 24,
 *       "jurisdiction": "San Francisco, CA", "governingLaw": "laws of the State of California",
 *       "confidentialInfo": "technical specs and financials", "mutual": false } }'
 *
 *   # Activate (sign) the NDA — returns contractId
 *   curl -X POST http://localhost:3000/contracts/nda/activate \
 *     -H "Authorization: Bearer $KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{ "data": { ...same as above... } }'
 *
 *   # Submit a disclosure event
 *   curl -X POST "http://localhost:3000/contracts/$CONTRACT_ID/events" \
 *     -H "Authorization: Bearer $KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{ "eventType": "DISCLOSURE_MADE", "party": "acme", "payload": { "description": "Q1 roadmap" } }'
 *
 *   # View audit log for a contract
 *   curl -H "Authorization: Bearer $KEY" \
 *     "http://localhost:3000/contracts/$CONTRACT_ID/audit"
 *
 *   # Register a webhook
 *   curl -X POST http://localhost:3000/webhooks \
 *     -H "Authorization: Bearer $KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{ "url": "https://example.com/hook", "events": ["contract.activated", "contract.event.processed"] }'
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@legal-agents/agents";
import {
  ContractRegistry,
  InMemoryApiKeyStore,
  startServer,
} from "@legal-agents/api";
import { ndaModel } from "./nda/model.js";
import { ndaTemplate } from "./nda/template.js";
import { ndaLogic } from "./nda/logic.js";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable is required");

const llm = new AnthropicClient(new Anthropic({ apiKey }), "claude-opus-4-7");

const registry = new ContractRegistry().register("nda", {
  model: ndaModel,
  template: ndaTemplate,
  logic: ndaLogic,
});

// Bootstrap: create a default org and print its API key on first start.
// In production, replace with your ApiKeyStore.create() call in an onboarding flow.
const apiKeys = new InMemoryApiKeyStore();
const { raw } = await apiKeys.create("org-default", "default", "live");
console.log(`\n  API Key (save this — shown once): ${raw}\n`);

startServer({
  registry,
  llm,
  apiKeys,
  port: Number(process.env["PORT"] ?? 3000),
});
