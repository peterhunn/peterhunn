/**
 * DocuSign CLM adapter for the x490 facilitator.
 *
 * Bridges DocuSign envelope lifecycle to x490 protocol in two modes:
 *
 *   Background (keep DocuSign UI):
 *     DocuSign envelope completed
 *       → fetch signers + document via DocuSign API
 *       → register template in x490
 *       → record agreements for each completed signer
 *       → x490 contractId available for downstream verification
 *
 *   Direct API (CLM calls x490 from their own UI):
 *     Pass externalSource="docusign" + externalId={envelopeId} in POST /accept
 *     Look up later via GET /v1/agreements/by-external?source=docusign&externalId={id}
 *
 * DocuSign Connect webhook docs:
 *   https://developers.docusign.com/platform/webhooks/connect/
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { signToken } from "@x490/protocol";
import type { AgreementRecord } from "../types.js";
import type { TemplateStore, RequirementsStore, AgreementStore } from "../store.js";
import type { IntegrationStore } from "../integration-store.js";

// ── DocuSign Connect wire types ────────────────────────────────────────────────

/**
 * DocuSign Connect webhook event (JSON format).
 * Configure JSON delivery in DocuSign Admin → Connect.
 */
export interface DocuSignConnectEvent {
  event:
    | "envelope-sent"
    | "envelope-completed"
    | "envelope-declined"
    | "envelope-voided"
    | "recipient-completed"
    | "recipient-sent";
  apiVersion: string;
  uri: string;
  retryCount: number;
  configurationId: number;
  generatedDateTime: string;
  data: {
    accountId: string;
    envelopeId: string;
    /** Included when "Aggregate Data" is enabled in Connect config. */
    envelopeSummary?: DocuSignEnvelope;
  };
}

export interface DocuSignEnvelope {
  envelopeId: string;
  status: "sent" | "delivered" | "completed" | "declined" | "voided";
  emailSubject: string;
  sender: { email: string; userName: string };
  recipients?: {
    signers?: DocuSignSigner[];
    carbonCopies?: DocuSignSigner[];
  };
  /** Populated when "Include Documents" is enabled in Connect config. */
  documents?: DocuSignDocumentSummary[];
  createdDateTime: string;
  completedDateTime?: string;
}

export interface DocuSignSigner {
  recipientId: string;
  name: string;
  email: string;
  status: "sent" | "delivered" | "completed" | "declined";
  signedDateTime?: string;
  routingOrder?: string;
}

export interface DocuSignDocumentSummary {
  documentId: string;
  name: string;
  /** "content" = the actual contract; "summary" = signing certificate */
  type: string;
  uri: string;
}

// ── DocuSign REST API client ───────────────────────────────────────────────────

export class DocuSignClient {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly accountId: string,
    /**
     * Account-specific base URL from DocuSign's userInfo endpoint.
     * Defaults to the North America production endpoint.
     */
    baseUrl = "https://na4.docusign.net/restapi/v2.1",
  ) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  private async req<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}/accounts/${this.accountId}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`DocuSign API ${res.status} ${path}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async getEnvelope(envelopeId: string): Promise<DocuSignEnvelope> {
    return this.req<DocuSignEnvelope>(`/envelopes/${envelopeId}?include=recipients,documents`);
  }

  async getRecipients(envelopeId: string): Promise<{ signers: DocuSignSigner[] }> {
    return this.req<{ signers: DocuSignSigner[] }>(`/envelopes/${envelopeId}/recipients`);
  }

  async listDocuments(envelopeId: string): Promise<DocuSignDocumentSummary[]> {
    const result = await this.req<{ envelopeDocuments: DocuSignDocumentSummary[] }>(
      `/envelopes/${envelopeId}/documents`,
    );
    return result.envelopeDocuments ?? [];
  }

  async getDocumentContent(envelopeId: string, documentId: string): Promise<ArrayBuffer> {
    const res = await fetch(
      `${this.base}/accounts/${this.accountId}/envelopes/${envelopeId}/documents/${documentId}`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
    if (!res.ok) throw new Error(`DocuSign document ${documentId}: ${res.status}`);
    return res.arrayBuffer();
  }
}

// ── Webhook signature verification ────────────────────────────────────────────

/**
 * Verify a DocuSign Connect webhook signature.
 *
 * DocuSign sends: `X-DocuSign-Signature-1: <base64(HMAC-SHA256(body, secret))>`
 * Multiple headers (Signature-2, etc.) can appear during key rotation; check
 * only the first one here since we manage a single active secret.
 */
export function verifyDocuSignSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  try {
    const buf1 = Buffer.from(expected, "base64");
    const buf2 = Buffer.from(signatureHeader, "base64");
    if (buf1.length !== buf2.length) return false;
    return timingSafeEqual(buf1, buf2);
  } catch {
    return false;
  }
}

// ── DocuSignWebhookAdapter ─────────────────────────────────────────────────────

export interface DocuSignEnvelopeRegistered {
  envelopeId: string;
  templateHash: string;
  /** x490 contractIds issued — one per completed signer */
  contractIds: string[];
  acceptUrl: string;
}

export interface DocuSignAdapterOptions {
  client: DocuSignClient;
  templates: TemplateStore;
  requirements: RequirementsStore;
  agreements: AgreementStore;
  integrations: IntegrationStore;
  tenantId: string;
  /** HMAC secret for signing x490 tokens — copy from the tenant record. */
  hmacSecret: string;
  facilitatorBaseUrl: string;
  /**
   * Token TTL in seconds. Defaults to 3 years — appropriate for fully executed
   * contracts where the signature is the point of completion.
   */
  expiresIn?: number;
  /**
   * Called for each agreement recorded (one per completed signer).
   * Use to push results to Salesforce, trigger downstream workflows, etc.
   * Errors are logged but do not fail the envelope processing.
   */
  onAgreementRecorded?: (record: AgreementRecord) => Promise<void>;
  /**
   * Called after a new envelope is registered.
   * Use to send a review link for envelopes that are still in-flight
   * (sent but not yet completed) so counterparties can preview the contract.
   */
  sendReviewLink?: (params: {
    reviewUrl: string;
    envelopeId: string;
    envelope: DocuSignEnvelope;
  }) => Promise<void>;
}

/**
 * Translates DocuSign envelope events into x490 protocol records.
 *
 * This is the background-mode adapter: DocuSign's native signing UI is
 * preserved entirely. x490 records each completed agreement so tokens
 * can be verified downstream.
 */
export class DocuSignWebhookAdapter {
  constructor(private readonly opts: DocuSignAdapterOptions) {}

  /**
   * Handle `envelope-completed` — register the envelope as an x490 template
   * and record agreements for every completed signer.
   *
   * Idempotent: if the envelope was already registered, only new completed
   * signers get new agreement records (handled by contractId uniqueness).
   */
  async onEnvelopeCompleted(
    envelopeId: string,
    envelopeSummary?: DocuSignEnvelope,
  ): Promise<DocuSignEnvelopeRegistered> {
    const {
      client, templates, requirements, agreements, integrations,
      tenantId, facilitatorBaseUrl,
    } = this.opts;
    const expiresIn = this.opts.expiresIn ?? 3 * 365 * 24 * 60 * 60;

    // Fetch full envelope data if not included in webhook payload
    const envelope = envelopeSummary ?? (await client.getEnvelope(envelopeId));

    // Idempotency: check if we already registered this envelope
    const existing = await integrations.findByExternal("docusign", envelopeId);
    let templateHash: string;

    if (existing) {
      templateHash = existing.templateHash;
    } else {
      // 1. Fetch document content
      const docs = await client.listDocuments(envelopeId);
      const primaryDoc = docs.find((d) => d.type === "content") ?? docs[0];
      let content = this.buildMarkdownEnvelope(envelope);

      if (primaryDoc) {
        const buf = await client.getDocumentContent(envelopeId, primaryDoc.documentId);
        content = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      }

      // 2. Register content-addressed template
      const tmpl = await templates.register(tenantId, content, {
        title: envelope.emailSubject,
        description: `DocuSign envelope ${envelopeId}`,
      });
      templateHash = tmpl.hash;

      // 3. Requirements (executed contracts — not negotiable)
      await requirements.upsert({
        tenantId,
        templateHash,
        resource: `docusign:${envelopeId}`,
        expiresIn,
        requiredPartyFields: ["name", "email"],
        negotiable: false,
      });

      // 4. Store integration mapping
      await integrations.save({
        source: "docusign",
        externalId: envelopeId,
        tenantId,
        templateHash,
      });

      // 5. Notify operator to send review link for in-flight envelopes
      if (this.opts.sendReviewLink && envelope.status !== "completed") {
        const reviewUrl = `${facilitatorBaseUrl.replace(/\/$/, "")}/v1/${tenantId}/review/${templateHash}`;
        void this.opts.sendReviewLink({ reviewUrl, envelopeId, envelope })
          .catch((err) => console.error("[docusign] sendReviewLink failed:", err));
      }
    }

    // 6. Record agreements for all completed signers
    const signers = envelope.recipients?.signers ?? [];
    const completedSigners = signers.filter((s) => s.status === "completed");
    const contractIds: string[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (const signer of completedSigners) {
      const contractId = crypto.randomUUID();
      const partyId = signer.email || signer.name;

      const token = await signToken(
        {
          contractId,
          templateHash,
          partyId,
          resource: `docusign:${envelopeId}`,
          iat: now,
          exp: now + expiresIn,
        },
        this.opts.hmacSecret,
      );

      const record: AgreementRecord = {
        contractId,
        tenantId,
        templateHash,
        partyId,
        resource: `docusign:${envelopeId}`,
        partyData: { name: signer.name, email: signer.email },
        token,
        issuedAt: now,
        expiresAt: now + expiresIn,
        externalSource: "docusign",
        externalId: envelopeId,
      };

      await agreements.record(record);
      contractIds.push(contractId);

      if (this.opts.onAgreementRecorded) {
        void this.opts.onAgreementRecorded(record)
          .catch((err) => console.error("[docusign] onAgreementRecorded failed:", err));
      }
    }

    return {
      envelopeId,
      templateHash,
      contractIds,
      acceptUrl: `${facilitatorBaseUrl.replace(/\/$/, "")}/v1/${tenantId}/accept`,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Generate a minimal Markdown summary of an envelope for template content. */
  private buildMarkdownEnvelope(envelope: DocuSignEnvelope): string {
    const lines = [`# ${envelope.emailSubject}`, ""];
    lines.push(`**Sender**: ${envelope.sender.userName} (${envelope.sender.email})`);
    const signers = envelope.recipients?.signers ?? [];
    if (signers.length > 0) {
      lines.push(`**Signers**: ${signers.map((s) => `${s.name} (${s.email})`).join(", ")}`);
    }
    if (envelope.completedDateTime) {
      lines.push(`**Completed**: ${envelope.completedDateTime}`);
    }
    return lines.join("\n");
  }
}
