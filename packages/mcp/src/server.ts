import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decodeToken } from "@x490/protocol";
import type {
  ContractRequirements,
  AcceptResponse,
  RevokeResponse,
} from "@x490/protocol";
import { b64decode } from "./codec.js";

// ── Agreement cache ────────────────────────────────────────────────────────────

interface CachedAgreement {
  contractId: string;
  templateId: string;
  resource: string;
  partyId: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

// ── Server factory ─────────────────────────────────────────────────────────────

export function createX490McpServer(): McpServer {
  // Per-instance agreement cache — each server has independent state.
  const agreements = new Map<string, CachedAgreement>();

  function cacheAgreement(token: string, templateId: string): CachedAgreement | null {
    const decoded = decodeToken(token);
    if (!decoded) return null;
    const entry: CachedAgreement = {
      contractId: decoded.payload.contractId,
      templateId,
      resource: decoded.payload.resource,
      partyId: decoded.payload.partyId,
      token,
      issuedAt: decoded.payload.iat,
      expiresAt: decoded.payload.exp,
    };
    agreements.set(decoded.payload.contractId, entry);
    return entry;
  }

  function activeAgreements(): CachedAgreement[] {
    const now = Math.floor(Date.now() / 1000);
    return [...agreements.values()].filter((a) => a.expiresAt > now);
  }

  const server = new McpServer({
    name: "x490",
    version: "0.1.0",
  });

  // ── Tool: inspect_requirements ───────────────────────────────────────────────

  server.tool(
    "inspect_requirements",
    "Fetch a URL and return its x490 ContractRequirements. Use this before accepting a contract to understand what you are agreeing to. Returns the full requirements including template URL, required fields, negotiable terms, and governing law.",
    { url: z.string().url().describe("URL of the x490-gated resource") },
    async ({ url }) => {
      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        return { content: [{ type: "text", text: `Fetch failed: ${String(e)}` }] };
      }

      // 490 — contract required
      const reqHeader = res.headers.get("X-490-Requirements");
      if (res.status === 490 && reqHeader) {
        try {
          const req = JSON.parse(b64decode(reqHeader)) as ContractRequirements;
          return { content: [{ type: "text", text: formatRequirements(req) }] };
        } catch {
          return { content: [{ type: "text", text: "490 received but X-490-Requirements header could not be decoded." }] };
        }
      }

      // 402 with x490 extension
      if (res.status === 402) {
        try {
          const body = await res.json() as { contractRequired?: ContractRequirements };
          if (body.contractRequired) {
            return { content: [{ type: "text", text: formatRequirements(body.contractRequired) }] };
          }
        } catch { /* fall through */ }
        return { content: [{ type: "text", text: "402 received but no contractRequired field in body (plain x402, no legal agreement needed)." }] };
      }

      // Already accessible
      if (res.ok) {
        return { content: [{ type: "text", text: `Resource returned ${res.status} — no contract gate detected. You may already have a valid agreement.` }] };
      }

      return { content: [{ type: "text", text: `Unexpected status ${res.status} from ${url}.` }] };
    },
  );

  // ── Tool: fetch_template ─────────────────────────────────────────────────────

  server.tool(
    "fetch_template",
    "Fetch and return the full contract template text from a templateUrl. Read this carefully before deciding whether to accept, reject, or negotiate the terms.",
    { templateUrl: z.string().url().describe("URL from ContractRequirements.templateUrl") },
    async ({ templateUrl }) => {
      let res: Response;
      try {
        res = await fetch(templateUrl);
      } catch (e) {
        return { content: [{ type: "text", text: `Fetch failed: ${String(e)}` }] };
      }
      if (!res.ok) {
        return { content: [{ type: "text", text: `Template fetch returned ${res.status}.` }] };
      }
      const ct = res.headers.get("content-type") ?? "";
      const text = ct.includes("json")
        ? JSON.stringify(await res.json(), null, 2)
        : await res.text();
      return { content: [{ type: "text", text: text }] };
    },
  );

  // ── Tool: accept_contract ────────────────────────────────────────────────────

  server.tool(
    "accept_contract",
    "Accept a contract by POSTing party data to the acceptEndpoint. Call inspect_requirements and fetch_template first to understand the terms. On success, the token is cached and returned.",
    {
      acceptEndpoint: z.string().url().describe("From ContractRequirements.acceptEndpoint"),
      templateId: z.string().describe("From ContractRequirements.templateId"),
      templateHash: z.string().describe("From ContractRequirements.templateHash"),
      partyData: z.record(z.string()).describe("Key-value party data (name, jurisdiction, etc.)"),
      negotiationTerms: z
        .record(z.unknown())
        .optional()
        .describe("Proposed modifications — only include when ContractRequirements.negotiable is true"),
      pendingContractId: z
        .string()
        .optional()
        .describe("For multi-party contracts: the contractId from the first signer's response"),
    },
    async ({ acceptEndpoint, templateId, templateHash, partyData, negotiationTerms, pendingContractId }) => {
      let res: Response;
      try {
        res = await fetch(acceptEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateId,
            templateHash,
            partyData,
            ...(negotiationTerms !== undefined ? { negotiationTerms } : {}),
            ...(pendingContractId !== undefined ? { pendingContractId } : {}),
          }),
        });
      } catch (e) {
        return { content: [{ type: "text", text: `Accept request failed: ${String(e)}` }] };
      }

      let body: AcceptResponse;
      try {
        body = await res.json() as AcceptResponse;
      } catch {
        return { content: [{ type: "text", text: `Accept endpoint returned ${res.status} with non-JSON body.` }] };
      }

      if (!res.ok) {
        return { content: [{ type: "text", text: `Accept failed (${res.status}): ${JSON.stringify(body)}` }] };
      }

      if (body.status === "accepted" && body.token) {
        const cached = cacheAgreement(body.token, templateId);
        return {
          content: [{
            type: "text",
            text: [
              `✓ Contract accepted.`,
              `  contractId: ${body.contractId}`,
              `  partyId:    ${cached?.partyId ?? "unknown"}`,
              `  resource:   ${cached?.resource ?? "unknown"}`,
              `  expires:    ${cached ? new Date(cached.expiresAt * 1000).toISOString() : "unknown"}`,
              `  token cached for future requests.`,
            ].join("\n"),
          }],
        };
      }

      if (body.status === "counter_offer" && body.counterOffer) {
        return {
          content: [{
            type: "text",
            text: [
              `↔ Server made a counter-offer. Review the modified terms below, then call accept_contract again (optionally with new negotiationTerms) or accept as-is.`,
              ``,
              formatRequirements(body.counterOffer),
            ].join("\n"),
          }],
        };
      }

      if (body.status === "pending") {
        return {
          content: [{
            type: "text",
            text: [
              `⏳ Acceptance recorded. Waiting for additional parties to co-sign.`,
              `  contractId:         ${body.contractId}`,
              `  parties signed:     ${body.pendingAcceptances ?? "?"}`,
              `  parties required:   ${body.requiredAcceptances ?? "?"}`,
              `  Share the contractId with the remaining parties so they can co-sign using pendingContractId.`,
            ].join("\n"),
          }],
        };
      }

      return { content: [{ type: "text", text: `Unexpected response: ${JSON.stringify(body)}` }] };
    },
  );

  // ── Tool: revoke_agreement ───────────────────────────────────────────────────

  server.tool(
    "revoke_agreement",
    "Revoke a previously accepted contract agreement. Use when the contract terms have been violated, the relationship has ended, or access should be terminated.",
    {
      revokeEndpoint: z.string().url().describe("From ContractRequirements.revokeEndpoint"),
      contractId: z.string().describe("The contractId to revoke"),
      reason: z.string().optional().describe("Human-readable reason for revocation"),
    },
    async ({ revokeEndpoint, contractId, reason }) => {
      let res: Response;
      try {
        res = await fetch(revokeEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contractId, ...(reason ? { reason } : {}) }),
        });
      } catch (e) {
        return { content: [{ type: "text", text: `Revoke request failed: ${String(e)}` }] };
      }

      const body = await res.json() as RevokeResponse;
      if (body.revoked) {
        agreements.delete(contractId);
        return { content: [{ type: "text", text: `✓ Agreement ${contractId} revoked.` }] };
      }
      return { content: [{ type: "text", text: `Revocation denied: ${JSON.stringify(body)}` }] };
    },
  );

  // ── Tool: list_agreements ────────────────────────────────────────────────────

  server.tool(
    "list_agreements",
    "List all active agreement tokens currently cached in this session. Shows which resources you have already agreed to access, and when they expire.",
    {},
    async () => {
      const active = activeAgreements();
      if (active.length === 0) {
        return { content: [{ type: "text", text: "No active agreements in this session." }] };
      }
      const lines = active.map((a) =>
        `• ${a.contractId}\n  template: ${a.templateId}\n  resource: ${a.resource}\n  party: ${a.partyId}\n  expires: ${new Date(a.expiresAt * 1000).toISOString()}`,
      );
      return { content: [{ type: "text", text: `${active.length} active agreement(s):\n\n${lines.join("\n\n")}` }] };
    },
  );

  // ── Tool: get_token ──────────────────────────────────────────────────────────

  server.tool(
    "get_token",
    "Retrieve a cached agreement token for a specific resource path or contractId. Use this to get the X-490-Contract header value needed for a gated request.",
    {
      contractId: z.string().optional().describe("Look up by contractId"),
      resource: z.string().optional().describe("Look up by resource path (e.g. /data)"),
    },
    async ({ contractId, resource }) => {
      const now = Math.floor(Date.now() / 1000);

      if (contractId) {
        const a = agreements.get(contractId);
        if (!a) return { content: [{ type: "text", text: `No cached agreement for contractId ${contractId}.` }] };
        if (a.expiresAt <= now) return { content: [{ type: "text", text: `Agreement ${contractId} has expired.` }] };
        return { content: [{ type: "text", text: `X-490-Contract: ${a.token}` }] };
      }

      if (resource) {
        const match = [...agreements.values()].find(
          (a) => a.expiresAt > now && (a.resource === "*" || a.resource === resource),
        );
        if (!match) return { content: [{ type: "text", text: `No cached agreement for resource ${resource}.` }] };
        return { content: [{ type: "text", text: `X-490-Contract: ${match.token}` }] };
      }

      return { content: [{ type: "text", text: "Provide either contractId or resource." }] };
    },
  );

  // ── Resource: x490://agreements ──────────────────────────────────────────────

  server.resource(
    "agreements",
    "x490://agreements",
    { mimeType: "application/json" },
    async () => ({
      contents: [{
        uri: "x490://agreements",
        mimeType: "application/json",
        text: JSON.stringify(activeAgreements(), null, 2),
      }],
    }),
  );

  return server;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function formatRequirements(req: ContractRequirements): string {
  const lines: string[] = [
    `Contract Requirements (x490 v${req.version})`,
    `${"─".repeat(48)}`,
    `template:      ${req.templateId}`,
    `description:   ${req.description}`,
    `resource:      ${req.resource}`,
    `expires in:    ${req.expiresIn}s`,
    `jurisdiction:  ${req.jurisdiction ?? "not specified"}`,
    `governing law: ${req.governingLaw ?? "not specified"}`,
    `negotiable:    ${req.negotiable ? "yes" : "no"}`,
  ];

  if (req.requiredParties && req.requiredParties > 1) {
    lines.push(`required parties: ${req.requiredParties}`);
  }

  lines.push(``, `required party fields: ${req.requiredPartyFields.join(", ")}`);
  lines.push(`template URL:  ${req.templateUrl}`);
  lines.push(`accept at:     ${req.acceptEndpoint}`);
  if (req.verifyEndpoint) lines.push(`verify at:     ${req.verifyEndpoint}`);
  if (req.revokeEndpoint) lines.push(`revoke at:     ${req.revokeEndpoint}`);

  if (req.negotiable && req.negotiableFields && req.negotiableFields.length > 0) {
    lines.push(``, `Negotiable fields:`);
    for (const nf of req.negotiableFields) {
      lines.push(`  • ${nf.field}: ${nf.description}`);
      if (nf.allowedValues) lines.push(`    allowed: ${nf.allowedValues.join(", ")}`);
    }
  }

  return lines.join("\n");
}
