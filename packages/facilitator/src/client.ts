import type { ContractRequirements, NegotiableField, AgreementRecord } from "./types-public.js";

export interface FacilitatorClientOptions {
  /** API key from POST /v1/tenants */
  apiKey: string;
  /** Tenant ID from POST /v1/tenants */
  tenantId: string;
  /** Facilitator base URL. Defaults to the hosted service. */
  baseUrl?: string;
}

interface UploadResult {
  hash: string;
  url: string;
  title?: string;
  description?: string;
}

/**
 * TypeScript SDK for server operators integrating with the x490 managed facilitator.
 *
 * Handles authentication, template registration, and building ContractRequirements
 * that point to the facilitator's accept/verify/revoke endpoints.
 *
 * Usage (on your server):
 *
 *   const facilitator = new FacilitatorClient({ apiKey, tenantId });
 *   const { hash } = await facilitator.uploadTemplate(ndaText, { title: "Data Use NDA" });
 *   const requirements = facilitator.buildRequirements({
 *     templateHash: hash,
 *     requiredPartyFields: ["name", "jurisdiction"],
 *     resource: "/data",
 *     description: "Data Use NDA",
 *     expiresIn: 3600,
 *   });
 *   // Now serve `requirements` in your 490 responses.
 *   // Use requireContract({ requirements, facilitated: true }) — no secret needed.
 */
export class FacilitatorClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: FacilitatorClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://facilitator.x490.dev";
  }

  /** Upload a contract template. Returns its content-addressed hash and hosted URL. */
  async uploadTemplate(
    content: string,
    meta: { title?: string; description?: string } = {},
  ): Promise<UploadResult> {
    const res = await this.post("/v1/templates", { content, ...meta });
    if (!res.ok) throw new Error(`Template upload failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<UploadResult>;
  }

  /**
   * Build ContractRequirements using a pre-registered template.
   *
   * All facilitator endpoints (accept, verify, revoke) are automatically set.
   * Pass the returned object directly to requireContract({ requirements, facilitated: true }).
   */
  async buildRequirements(opts: {
    templateHash: string;
    requiredPartyFields: string[];
    resource: string;
    description: string;
    expiresIn: number;
    negotiable?: boolean;
    negotiableFields?: NegotiableField[];
    requiredParties?: number;
    jurisdiction?: string;
    governingLaw?: string;
  }): Promise<ContractRequirements> {
    const res = await this.post("/v1/requirements", opts);
    if (!res.ok) throw new Error(`buildRequirements failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<ContractRequirements>;
  }

  /** List all agreements for your tenant, optionally filtered by resource path. */
  async listAgreements(filters: { resource?: string } = {}): Promise<AgreementRecord[]> {
    const qs = filters.resource ? `?resource=${encodeURIComponent(filters.resource)}` : "";
    const res = await this.get(`/v1/agreements${qs}`);
    if (!res.ok) throw new Error(`listAgreements failed: ${res.status} ${await res.text()}`);
    const { agreements } = await res.json() as { agreements: AgreementRecord[] };
    return agreements;
  }

  /** Get a single agreement by contractId. Returns null if not found. */
  async getAgreement(contractId: string): Promise<AgreementRecord | null> {
    const res = await this.get(`/v1/agreements/${contractId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getAgreement failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<AgreementRecord>;
  }

  /** Revoke an agreement. After this, the token will be rejected by the facilitator verify endpoint. */
  async revokeAgreement(contractId: string, reason?: string): Promise<void> {
    const res = await this.post(`/v1/${this.opts.tenantId}/revoke`, {
      contractId,
      ...(reason ? { reason } : {}),
    });
    if (!res.ok) throw new Error(`revokeAgreement failed: ${res.status} ${await res.text()}`);
  }

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.opts.apiKey },
      body: JSON.stringify(body),
    });
  }

  private get(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      headers: { "X-API-Key": this.opts.apiKey },
    });
  }
}

/**
 * Sign up for the managed facilitator service.
 *
 * Call once to create your tenant. Store the returned apiKey securely —
 * it is shown exactly once and cannot be recovered.
 */
export async function signUp(
  name: string,
  baseUrl = "https://facilitator.x490.dev",
): Promise<{ tenantId: string; apiKey: string }> {
  const res = await fetch(`${baseUrl}/v1/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`signUp failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { tenantId: string; apiKey: string };
  return { tenantId: body.tenantId, apiKey: body.apiKey };
}
