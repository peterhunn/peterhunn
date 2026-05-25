/**
 * Ironclad CLM adapter for the x490 facilitator.
 *
 * Bridges Ironclad contract workflows to x490 protocol negotiation:
 *
 *   Ironclad workflow created
 *     → fetch document + attributes from Ironclad API
 *     → register template in x490 facilitator
 *     → return accept URL for counterparties
 *
 *   Counterparty accepts via x490
 *     → onAgreementAccepted() called by facilitator
 *     → push agreed terms + comment back to Ironclad workflow
 *
 * Ironclad API reference: https://developer.ironcladapp.com/reference
 */

import { createHmac } from "node:crypto";
import type { TemplateStore, RequirementsStore } from "../store.js";
import type { IntegrationStore } from "../integration-store.js";
import type { NegotiableField } from "@x490/protocol";

// ── Ironclad API wire types ────────────────────────────────────────────────────

export interface IroncladWorkflow {
  id: string;
  title: string;
  status: "running" | "approved" | "declined" | "cancelled";
  creator: { id: string; email: string; name: string };
  /** Schema used to create this workflow. Maps to x490 templateId. */
  schemaId: string;
  /** User-visible workflow attributes (contract fields). */
  attributes: Record<string, IroncladAttribute>;
  signatories: IroncladSignatory[];
  createdAt: string;
  updatedAt: string;
}

export interface IroncladAttribute {
  displayName: string;
  /** Ironclad attribute type. */
  type: "shortText" | "longText" | "longTextBlock" | "number" | "date" | "singleselect" | "boolean";
  value: string | number | boolean | null;
  required?: boolean;
  options?: string[];
}

export interface IroncladSignatory {
  id: string;
  name: string;
  email: string;
  role: string;
  signedAt?: string;
}

export interface IroncladDocument {
  id: string;
  name: string;
  type: "primary" | "attachment";
  mimeType: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | string;
}

export interface IroncladWebhookEvent {
  event:
    | "workflow_created"
    | "workflow_approved"
    | "workflow_declined"
    | "workflow_cancelled"
    | "signatory_completed"
    | "comment_created";
  payload: {
    workflowId: string;
    metadata?: Record<string, unknown>;
  };
}

// ── Ironclad REST API client ───────────────────────────────────────────────────

export class IroncladClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    { baseUrl = "https://ironcladapp.com/public/api/v1" } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Ironclad API ${res.status} ${path}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async getWorkflow(workflowId: string): Promise<IroncladWorkflow> {
    return this.req<IroncladWorkflow>(`/workflows/${workflowId}`);
  }

  async listDocuments(workflowId: string): Promise<IroncladDocument[]> {
    const result = await this.req<{ documents: IroncladDocument[] }>(
      `/workflows/${workflowId}/documents`,
    );
    return result.documents;
  }

  async getDocumentContent(documentId: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}/documents/${documentId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`Ironclad document ${documentId}: ${res.status}`);
    return res.arrayBuffer();
  }

  async addComment(workflowId: string, comment: string): Promise<void> {
    await this.req(`/workflows/${workflowId}/comments`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    });
  }

  /**
   * Push negotiated attribute values back to the Ironclad workflow.
   * Only called when the counterparty proposes changes that the server accepts.
   */
  async updateAttributes(
    workflowId: string,
    attributes: Record<string, unknown>,
  ): Promise<void> {
    await this.req(`/workflows/${workflowId}`, {
      method: "PATCH",
      body: JSON.stringify({ attributes }),
    });
  }
}

// ── Webhook signature verification ────────────────────────────────────────────

/**
 * Verify an Ironclad webhook signature.
 *
 * Ironclad sends: `X-Ironclad-Hmac-Sha256: sha256=<hex>`
 * where the HMAC is computed over the raw request body with the webhook secret.
 */
export function verifyIroncladSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const eqIdx = signatureHeader.indexOf("=");
  if (eqIdx === -1) return false;
  const algo = signatureHeader.slice(0, eqIdx);
  const sig = signatureHeader.slice(eqIdx + 1);
  if (algo !== "sha256" || !sig) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  // Constant-time comparison to resist timing attacks
  if (expected.length !== sig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ (sig.charCodeAt(i) ?? 0);
  }
  return mismatch === 0;
}

// ── IroncladWebhookAdapter ─────────────────────────────────────────────────────

export interface IroncladAdapterOptions {
  client: IroncladClient;
  templates: TemplateStore;
  requirements: RequirementsStore;
  integrations: IntegrationStore;
  tenantId: string;
  facilitatorBaseUrl: string;
}

export interface IroncladWorkflowRegistered {
  /** The x490 accept endpoint URL to send to counterparties. */
  acceptUrl: string;
  templateHash: string;
  workflowId: string;
  /** x490 ContractRequirements as JSON — embed this in emails/links to counterparties. */
  requirements: Record<string, unknown>;
}

/**
 * Translates Ironclad workflow events into x490 protocol actions.
 *
 * Mount one instance per tenant. The `tenantId` must already exist in the
 * facilitator's tenant store.
 */
export class IroncladWebhookAdapter {
  constructor(private readonly opts: IroncladAdapterOptions) {}

  /**
   * Handle `workflow_created` — register the Ironclad document as an x490
   * template and return the counterparty accept URL.
   *
   * Call this from your webhook route when `event === "workflow_created"`.
   */
  async onWorkflowCreated(workflowId: string): Promise<IroncladWorkflowRegistered> {
    const { client, templates, requirements, integrations, tenantId, facilitatorBaseUrl } = this.opts;

    // Check if we've already registered this workflow (idempotency)
    const existing = await integrations.findByExternal("ironclad", workflowId);
    if (existing) {
      return this.buildResult(existing.templateHash, workflowId, facilitatorBaseUrl, tenantId);
    }

    // 1. Fetch workflow metadata and document
    const workflow = await client.getWorkflow(workflowId);
    const docs = await client.listDocuments(workflowId);

    // Prefer primary document; fall back to first attachment
    const primaryDoc = docs.find((d) => d.type === "primary") ?? docs[0];
    let templateContent = this.buildMarkdownTemplate(workflow);

    if (primaryDoc) {
      // Store raw document bytes; facilitator serves them via /v1/templates/:hash
      const buf = await client.getDocumentContent(primaryDoc.id);
      templateContent = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    }

    // 2. Register content-addressed template
    const tmpl = await templates.register(tenantId, templateContent, {
      title: workflow.title,
      description: `Ironclad workflow ${workflowId} (schema: ${workflow.schemaId})`,
    });

    // 3. Build negotiable fields from Ironclad attributes
    //    Negotiable = free-text or numeric fields that aren't marked required.
    const negotiableFields: NegotiableField[] = Object.entries(workflow.attributes)
      .filter(([, attr]) => !attr.required && (attr.type === "shortText" || attr.type === "number" || attr.type === "longText"))
      .map(([key, attr]) => ({
        field: key,
        description: attr.displayName,
        ...(attr.options ? { allowedValues: attr.options } : {}),
      }));

    // 4. Upsert requirements config
    await requirements.upsert({
      tenantId,
      templateHash: tmpl.hash,
      resource: `ironclad:${workflowId}`,
      expiresIn: 90 * 24 * 60 * 60, // 90 days — standard commercial contract window
      requiredPartyFields: ["name", "email"],
      negotiable: negotiableFields.length > 0,
      negotiableFields,
    });

    // 5. Store integration mapping for outbound (accept → Ironclad) callbacks
    await integrations.save({
      source: "ironclad",
      externalId: workflowId,
      tenantId,
      templateHash: tmpl.hash,
    });

    return this.buildResult(tmpl.hash, workflowId, facilitatorBaseUrl, tenantId);
  }

  /**
   * Called by the facilitator's onAgreementCreated hook when a counterparty
   * accepts a contract that originated from Ironclad.
   *
   * Pushes negotiated terms back and adds a comment to the Ironclad workflow.
   */
  async onAgreementAccepted(
    workflowId: string,
    partyData: Record<string, string>,
    negotiationTerms?: Record<string, unknown>,
  ): Promise<void> {
    const { client } = this.opts;

    // Push any agreed-upon attribute changes back to Ironclad
    const attributeUpdates = negotiationTerms
      ? Object.fromEntries(
          Object.entries(negotiationTerms).filter(([k]) => k !== "clauses"),
        )
      : {};

    if (Object.keys(attributeUpdates).length > 0) {
      await client.updateAttributes(workflowId, attributeUpdates).catch((err) => {
        console.error(`[ironclad] failed to push attributes for ${workflowId}:`, err);
      });
    }

    const who = partyData["name"] ?? partyData["email"] ?? "counterparty";
    const ts = new Date().toUTCString();
    await client
      .addComment(
        workflowId,
        `Accepted by ${who} via x490 protocol at ${ts}. ` +
          `Agreement recorded on the x490 facilitator. ` +
          (Object.keys(attributeUpdates).length > 0
            ? `Negotiated fields: ${Object.keys(attributeUpdates).join(", ")}.`
            : "No terms were modified."),
      )
      .catch((err) => {
        console.error(`[ironclad] failed to add comment for ${workflowId}:`, err);
      });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private buildResult(
    templateHash: string,
    workflowId: string,
    facilitatorBaseUrl: string,
    tenantId: string,
  ): IroncladWorkflowRegistered {
    const base = facilitatorBaseUrl.replace(/\/$/, "");
    const acceptUrl = `${base}/v1/${tenantId}/accept`;
    return {
      acceptUrl,
      templateHash,
      workflowId,
      requirements: {
        scheme: "x490",
        version: 1,
        templateId: `ironclad:${workflowId}`,
        templateUrl: `${base}/v1/templates/${templateHash}`,
        templateHash,
        acceptEndpoint: acceptUrl,
        requiredPartyFields: ["name", "email"],
      },
    };
  }

  /** Generate a minimal Markdown template from Ironclad workflow attributes. */
  private buildMarkdownTemplate(workflow: IroncladWorkflow): string {
    const lines = [`# ${workflow.title}`, ""];
    for (const [key, attr] of Object.entries(workflow.attributes)) {
      const val = attr.value !== null ? String(attr.value) : "_[to be determined]_";
      lines.push(`**${attr.displayName}**: <!-- clause:${key} -->${val}<!-- /clause:${key} -->`);
    }
    return lines.join("\n");
  }
}
