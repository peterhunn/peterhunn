/**
 * NDA agent — shows how to wire together model, template, logic, and LLM
 * to build a complete legal AI agent for Non-Disclosure Agreements.
 *
 * Run:  npm run run:nda  (requires ANTHROPIC_API_KEY env var)
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@legal-agents/agents";
import { ContractAgent } from "@legal-agents/agents";
import { ndaTemplate } from "./template.js";
import { ndaLogic } from "./logic.js";
import type { NDAData } from "./model.js";

async function main() {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const llm = new AnthropicClient(new Anthropic({ apiKey }), "claude-opus-4-7");
  const agent = new ContractAgent(ndaTemplate, ndaLogic, llm);

  // --- 1. Draft a contract from structured data ---
  const contractData: NDAData = {
    $class: "org.accordproject.nda.NDAContract",
    disclosingParty: {
      $class: "org.accordproject.party.Party",
      partyId: "party-acme",
      name: "Acme Corporation",
      role: "Disclosing Party",
      email: "legal@acme.example.com",
    },
    receivingParty: {
      $class: "org.accordproject.party.Party",
      partyId: "party-beta",
      name: "Beta Ventures Inc.",
      role: "Receiving Party",
      email: "legal@beta.example.com",
    },
    effectiveDate: "2026-01-15",
    durationMonths: 24,
    jurisdiction: "San Francisco, California, USA",
    governingLaw: "laws of the State of California",
    confidentialInfo:
      "technical specifications, business plans, financial projections, and customer data",
    mutual: false,
  };

  console.log("=== 1. DRAFTING CONTRACT ===\n");
  const contractText = agent.draft(contractData);
  console.log(contractText);

  // --- 2. Activate the contract (initialize state with obligations) ---
  console.log("\n=== 2. ACTIVATING CONTRACT ===\n");
  let state = agent.activate(contractData);
  console.log(`Status: ${state.status}`);
  console.log(`Obligations (${state.obligations.length}):`);
  for (const o of state.obligations) {
    console.log(`  - [${o.party}] ${o.action} (deadline: ${o.deadline ?? "none"})`);
  }

  // --- 3. Record a disclosure event ---
  console.log("\n=== 3. RECORDING DISCLOSURE ===\n");
  const disclosureResult = agent.execute(
    {
      $class: "org.accordproject.nda.DISCLOSURE_MADE",
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      party: "party-acme",
      type: "DISCLOSURE_MADE",
      payload: { description: "Q4 2025 financial projections and roadmap" },
    },
    state,
    contractData,
  );
  state = disclosureResult.state;
  console.log(disclosureResult.result.message);

  // --- 4. AI-powered compliance check ---
  console.log("\n=== 4. COMPLIANCE CHECK ===\n");
  const compliance = await agent.checkCompliance(contractText, [
    "NDA must specify a confidentiality period",
    "NDA must identify both parties by name",
    "NDA must describe what constitutes confidential information",
    "NDA must specify governing law",
  ]);
  console.log(`Overall: ${compliance.passed ? "PASSED" : "FAILED"}`);
  for (const r of compliance.results) {
    console.log(`  ${r.satisfied ? "✓" : "✗"} ${r.requirement}`);
    if (!r.satisfied) console.log(`    → ${r.explanation}`);
  }

  // --- 5. AI-powered analysis ---
  console.log("\n=== 5. CONTRACT ANALYSIS ===\n");
  const analysis = await agent.analyze(contractText);
  console.log(`Summary: ${analysis.summary}\n`);
  console.log(`Parties: ${analysis.parties.map((p) => `${p.name} (${p.role})`).join(", ")}`);
  if (analysis.risks.length > 0) {
    console.log(`\nRisks flagged:`);
    for (const risk of analysis.risks) console.log(`  - ${risk}`);
  }
}

main().catch(console.error);
