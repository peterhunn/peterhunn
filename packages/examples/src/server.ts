/**
 * Example HTTP server — NDA contract type registered and running on port 3000.
 *
 * Run:  ANTHROPIC_API_KEY=sk-... npm run run:server  (from packages/examples)
 *
 * Then try:
 *
 *   # List registered contract types
 *   curl http://localhost:3000/contracts
 *
 *   # Draft an NDA
 *   curl -X POST http://localhost:3000/contracts/nda/draft \
 *     -H "Content-Type: application/json" \
 *     -d @- <<'EOF'
 *   {
 *     "data": {
 *       "$class": "org.accordproject.nda.NDAContract",
 *       "disclosingParty": { "$class": "org.accordproject.party.Party", "partyId": "acme", "name": "Acme Corp" },
 *       "receivingParty": { "$class": "org.accordproject.party.Party", "partyId": "beta", "name": "Beta Inc" },
 *       "effectiveDate": "2026-01-15",
 *       "durationMonths": 24,
 *       "jurisdiction": "San Francisco, CA",
 *       "governingLaw": "laws of the State of California",
 *       "confidentialInfo": "technical specs, business plans, and financials",
 *       "mutual": false
 *     }
 *   }
 *   EOF
 *
 *   # Activate (sign) an NDA — returns contractId
 *   curl -X POST http://localhost:3000/contracts/nda/activate \
 *     -H "Content-Type: application/json" \
 *     -d '{ "data": { ...same as above... } }'
 *
 *   # Submit an event to a live contract
 *   curl -X POST http://localhost:3000/contracts/<contractId>/events \
 *     -H "Content-Type: application/json" \
 *     -d '{ "eventType": "DISCLOSURE_MADE", "party": "acme", "payload": { "description": "Q1 roadmap" } }'
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@legal-agents/agents";
import { ContractRegistry, startServer } from "@legal-agents/api";
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

startServer({
  registry,
  llm,
  port: Number(process.env["PORT"] ?? 3000),
});
