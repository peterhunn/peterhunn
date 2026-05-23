import type {
  ContractRequirements,
  AcceptRequest,
  AcceptResponse,
  X402Response,
} from "./types.js";
import { decodeToken } from "./token.js";
import { b64decode } from "./codec.js";

export interface ContractClientOptions {
  /**
   * Party data sent in AcceptRequest.partyData.
   * Pass a function to resolve fields dynamically per-requirements — useful when
   * different contracts ask for different identity fields, or when the agent's
   * credentials are fetched at runtime.
   */
  partyData:
    | Record<string, string>
    | ((requirements: ContractRequirements) => Record<string, string> | Promise<Record<string, string>>);
  /**
   * Called when a server counter-offers. Return modified terms to propose back,
   * or undefined to accept the counter-offer as-is.
   */
  onNegotiation?: (
    requirements: ContractRequirements,
  ) => Promise<Record<string, unknown> | undefined>;
  /**
   * Called before accepting — lets the caller inspect and reject terms.
   * Throw to abort; return to accept.
   */
  onRequirements?: (requirements: ContractRequirements) => Promise<void>;
  /**
   * Called when a previously cached contract token is rejected by the server
   * (server returns 490 even though a token was presented). Receives the
   * contractId of the evicted token — useful for logging or alerting.
   */
  onRevoked?: (contractId: string) => void | Promise<void>;
  /** External token cache — useful for sharing across ContractClient instances */
  cache?: Map<string, string>;
  /** Max negotiation round-trips before giving up (default: 3) */
  maxNegotiationRounds?: number;
  /**
   * Seconds before a token's expiry at which the client proactively refreshes it.
   * Prevents serving a token that expires mid-request. Default: 60.
   */
  tokenRefreshThreshold?: number;
  /**
   * Skip fetching and verifying the template hash before accepting (default: false).
   * Set to true only in tests or environments where the template server is unavailable.
   */
  skipTemplateVerification?: boolean;
  /**
   * When true, the client calls verifyEndpoint before attaching a cached token
   * to confirm the contract hasn't been revoked server-side. Adds one round-trip
   * per request. Default: false.
   */
  checkRevocationOnUse?: boolean;
}

/**
 * A fetch-compatible client that automatically traverses the x490 protocol.
 *
 * On a 490 with X-490-Requirements, it establishes the agreement and retries
 * with X-490-Contract. On a 402 with contractRequired in the body, it handles
 * the x490 gate before the caller handles x402 payment.
 *
 * Usage:
 *   const client = new ContractClient({ partyData: { name: "Acme Corp", ... } });
 *   const res = await client.fetch("https://api.example.com/data");
 */
export class ContractClient {
  private readonly cache: Map<string, string>;
  private readonly maxRounds: number;
  private readonly refreshThreshold: number;
  private readonly verifiedHashes = new Set<string>();
  private readonly verifyEndpointByHash = new Map<string, string>();

  constructor(private readonly opts: ContractClientOptions) {
    this.cache = opts.cache ?? new Map();
    this.maxRounds = opts.maxNegotiationRounds ?? 3;
    this.refreshThreshold = opts.tokenRefreshThreshold ?? 60;
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);

    // Pre-attach a cached valid token if available for this resource
    const cached = this.findCachedToken(new URL(url).pathname);
    // Track whether the token was already evicted by the proactive revocation check
    // so the 490 handler does not fire onRevoked a second time.
    let alreadyEvicted = false;
    if (cached && this.opts.checkRevocationOnUse) {
      const revoked = await this.checkIfRevoked(cached);
      if (revoked) {
        this.evictToken(cached);  // remove from cache
        alreadyEvicted = true;
        const decoded = decodeToken(cached);
        if (decoded) void this.opts.onRevoked?.(decoded.payload.contractId);
        // don't attach — let the 490 flow re-establish
      } else {
        headers.set("X-490-Contract", cached);
      }
    } else if (cached) {
      headers.set("X-490-Contract", cached);
    }

    const response = await fetch(url, { ...init, headers });

    // x490 gate on 490
    if (response.status === 490) {
      const reqHeader = response.headers.get("X-490-Requirements");
      if (!reqHeader) return response;

      const requirements = JSON.parse(b64decode(reqHeader)) as ContractRequirements;

      // If we presented a cached token that the server rejected, evict it and
      // notify the caller — the contract may have been revoked server-side.
      // Skip if the token was already evicted by the proactive revocation check above.
      if (cached && !alreadyEvicted) {
        const decoded = decodeToken(cached);
        if (decoded) void this.opts.onRevoked?.(decoded.payload.contractId);
        this.cache.delete(requirements.templateHash);
      }

      const token = await this.establishAgreement(requirements);

      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("X-490-Contract", token);
      return fetch(url, { ...init, headers: retryHeaders });
    }

    // x402 + x490 combined gate on 402
    if (response.status === 402) {
      const body = (await response.clone().json()) as X402Response;
      if (body.contractRequired) {
        await this.establishAgreement(body.contractRequired);
        // Return the 402 with the x490 requirement satisfied — the caller
        // handles x402 payment on top. The token is now cached for the retry.
      }
    }

    return response;
  }

  /** Establish a contract agreement, handling negotiation round-trips. */
  async establishAgreement(requirements: ContractRequirements): Promise<string> {
    const cached = this.cache.get(requirements.templateHash);
    if (cached && !this.isExpiredOrNearExpiry(cached)) return cached;

    await this.opts.onRequirements?.(requirements);

    if (!this.opts.skipTemplateVerification) {
      await this.verifyTemplateHash(requirements);
    }

    let current = requirements;
    let round = 0;

    while (round < this.maxRounds) {
      const negotiationTerms =
        current.negotiable ? await this.opts.onNegotiation?.(current) : undefined;

      const partyData = typeof this.opts.partyData === "function"
        ? await this.opts.partyData(current)
        : this.opts.partyData;

      // Pre-validate required fields before the network round-trip.
      if (current.requiredPartyFields?.length) {
        const missing = current.requiredPartyFields.filter(
          (f) => !(f in partyData) || (partyData[f] ?? "").trim() === "",
        );
        if (missing.length > 0) {
          throw new Error(`x490: missing required party fields: ${missing.join(", ")}`);
        }
      }

      const body: AcceptRequest = {
        templateId: current.templateId,
        templateHash: current.templateHash,
        partyData,
        ...(negotiationTerms !== undefined ? { negotiationTerms } : {}),
      };

      // Use negotiateEndpoint when proposing terms and the server exposes one.
      const useNegotiate = negotiationTerms !== undefined && current.negotiateEndpoint !== undefined;
      const endpoint = useNegotiate ? current.negotiateEndpoint! : current.acceptEndpoint;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`x490 accept failed: ${res.status} ${await res.text()}`);
      }

      const result = (await res.json()) as AcceptResponse;

      if (result.status === "accepted") {
        this.cache.set(requirements.templateHash, result.token);
        if (requirements.verifyEndpoint) {
          this.verifyEndpointByHash.set(requirements.templateHash, requirements.verifyEndpoint);
        }
        if (result.counterOffer) {
          this.cache.set(result.counterOffer.templateHash, result.token);
          if (result.counterOffer.verifyEndpoint) {
            this.verifyEndpointByHash.set(result.counterOffer.templateHash, result.counterOffer.verifyEndpoint);
          }
        }
        return result.token;
      }

      if (result.status === "counter_offer" && result.counterOffer) {
        current = result.counterOffer;
        round++;
        continue;
      }

      throw new Error("Unexpected accept response status");
    }

    throw new Error(`x490 negotiation exceeded ${this.maxRounds} rounds`);
  }

  private async verifyTemplateHash(requirements: ContractRequirements): Promise<void> {
    if (this.verifiedHashes.has(requirements.templateHash)) return;
    const res = await fetch(requirements.templateUrl);
    if (!res.ok) {
      throw new Error(`x490: failed to fetch template at ${requirements.templateUrl}: ${res.status}`);
    }
    const content = await res.text();
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== requirements.templateHash) {
      throw new Error(
        `x490: template hash mismatch — content may have been tampered. ` +
        `Expected ${requirements.templateHash}, got ${hex}`,
      );
    }
    this.verifiedHashes.add(requirements.templateHash);
  }

  /** Attach a cached agreement token to an existing Headers object if available. */
  attachToken(resource: string, headers: Headers): void {
    const token = this.findCachedToken(resource);
    if (token) headers.set("X-490-Contract", token);
  }

  private findCachedToken(resource: string): string | undefined {
    for (const token of this.cache.values()) {
      if (this.isExpiredOrNearExpiry(token)) continue;
      const decoded = decodeToken(token);
      if (!decoded) continue;
      if (decoded.payload.resource === "*" || decoded.payload.resource === resource) {
        return token;
      }
    }
    return undefined;
  }

  private isExpiredOrNearExpiry(raw: string): boolean {
    const decoded = decodeToken(raw);
    if (!decoded) return true;
    return decoded.payload.exp - Math.floor(Date.now() / 1000) < this.refreshThreshold;
  }

  private async checkIfRevoked(token: string): Promise<boolean> {
    // Find the templateHash for this token by scanning the cache
    let templateHash: string | undefined;
    for (const [hash, cached] of this.cache.entries()) {
      if (cached === token) {
        templateHash = hash;
        break;
      }
    }

    if (!templateHash) return false;

    const verifyEndpoint = this.verifyEndpointByHash.get(templateHash);
    if (!verifyEndpoint) return false;

    try {
      const res = await fetch(`${verifyEndpoint}?token=${encodeURIComponent(token)}`);
      if (res.ok) {
        const body = (await res.json()) as { valid: boolean };
        if (body.valid === false) return true; // revoked
      }
    } catch {
      // fail open — can't reach verify endpoint
    }
    return false;
  }

  private evictToken(token: string): void {
    for (const [hash, cached] of this.cache.entries()) {
      if (cached === token) {
        this.cache.delete(hash);
        this.verifyEndpointByHash.delete(hash);
        break;
      }
    }
  }
}
