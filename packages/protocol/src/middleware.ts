import type { MiddlewareHandler } from "hono";
import type {
  ContractRequirements,
  AcceptRequest,
  AcceptResponse,
  RevokeRequest,
  RevokeResponse,
  DiscoveryDocument,
  DiscoveryResource,
} from "./types.js";
import { signToken, verifyToken } from "./token.js";
import { b64encode } from "./codec.js";
import type { RevocationStore } from "./revocation.js";
import type { PendingContractStore } from "./pending.js";

/** Build a 490 response. Native Response bypasses Hono's ContentfulStatusCode union. */
function x490Response(body: unknown, requirements: ContractRequirements): Response {
  return new Response(JSON.stringify(body), {
    status: 490,
    headers: {
      "Content-Type": "application/json",
      "X-490-Requirements": b64encode(JSON.stringify(requirements)),
    },
  });
}

declare module "hono" {
  interface ContextVariableMap {
    x490ContractId: string;
    x490PartyId: string;
  }
}

export interface ContractGateOptions {
  requirements: ContractRequirements;
  /** HMAC secret used to sign and verify tokens */
  secret: string;
  /** Optional revocation store — tokens for revoked contractIds are rejected */
  revocationStore?: RevocationStore;
}

/**
 * Hono middleware that gates a route behind an x490 contract agreement.
 *
 * Returns 490 with X-490-Requirements when the header is absent or invalid.
 * On success, sets c.var.x490ContractId and c.var.x490PartyId.
 */
export function requireContract(opts: ContractGateOptions): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.header("X-490-Contract");

    if (!raw) {
      return x490Response(
        { error: "Contract agreement required", contractRequired: opts.requirements },
        opts.requirements,
      );
    }

    const result = await verifyToken(raw, opts.secret, c.req.path);
    if (!result.valid) {
      return x490Response(
        { error: result.reason, contractRequired: opts.requirements },
        opts.requirements,
      );
    }

    if (opts.revocationStore) {
      const revoked = await opts.revocationStore.isRevoked(result.payload.contractId);
      if (revoked) {
        return x490Response(
          { error: "Contract has been revoked", contractRequired: opts.requirements },
          opts.requirements,
        );
      }
    }

    c.set("x490ContractId", result.payload.contractId);
    c.set("x490PartyId", result.payload.partyId);
    await next();
  };
}

export interface AcceptHandlerOptions {
  requirements: ContractRequirements;
  secret: string;
  /** Token TTL in seconds — defaults to ContractRequirements.expiresIn */
  ttl?: number;
  /**
   * Optional negotiation handler. Return a modified ContractRequirements to
   * counter-offer, or undefined/null to accept the terms as proposed.
   */
  onNegotiation?: (
    terms: Record<string, unknown>,
    partyData: Record<string, string>,
  ) => Promise<ContractRequirements | null | undefined>;
  /** Called after successful acceptance to record the agreement. */
  onAccepted?: (
    contractId: string,
    partyData: Record<string, string>,
    templateHash: string,
  ) => Promise<void>;
  /**
   * Required for multi-party flows (ContractRequirements.requiredParties > 1).
   * Tracks parties that have signed so far before a token is issued.
   */
  pendingStore?: PendingContractStore;
}

/**
 * Hono handler for the acceptEndpoint.
 *
 * Handles negotiation round-trips, multi-party co-signing, and token issuance.
 * Mount at ContractRequirements.acceptEndpoint.
 */
export function acceptHandler(opts: AcceptHandlerOptions): MiddlewareHandler {
  return async (c) => {
    const body = await c.req.json<AcceptRequest>();

    if (body.templateHash !== opts.requirements.templateHash) {
      return c.json({ error: "templateHash mismatch" }, 400);
    }

    const missing = opts.requirements.requiredPartyFields.filter(
      (f) => !(f in body.partyData),
    );
    if (missing.length > 0) {
      return c.json({ error: "missing partyData fields", missing }, 400);
    }

    // Negotiation round-trip
    if (body.negotiationTerms && opts.requirements.negotiable) {
      const { negotiableFields } = opts.requirements;

      if (negotiableFields && negotiableFields.length > 0) {
        const allowedFieldNames = new Set(negotiableFields.map((nf) => nf.field));
        const invalidFields = Object.keys(body.negotiationTerms).filter(
          (f) => !allowedFieldNames.has(f),
        );
        if (invalidFields.length > 0) {
          return c.json(
            {
              error: "proposed fields are not negotiable",
              invalidFields,
              negotiableFields: negotiableFields.map((nf) => nf.field),
            },
            400,
          );
        }

        for (const [field, value] of Object.entries(body.negotiationTerms)) {
          const spec = negotiableFields.find((nf) => nf.field === field);
          if (spec?.allowedValues && !spec.allowedValues.includes(value as string)) {
            return c.json(
              {
                error: "proposed value not in allowedValues",
                field,
                proposed: value,
                allowedValues: spec.allowedValues,
              },
              400,
            );
          }
        }
      }

      const counter = await opts.onNegotiation?.(body.negotiationTerms, body.partyData);
      if (counter) {
        const contractId = crypto.randomUUID();
        const response: AcceptResponse = {
          status: "counter_offer",
          contractId,
          token: "",
          counterOffer: counter,
        };
        return c.json(response, 200);
      }
    }

    // Multi-party flow
    const requiredParties = opts.requirements.requiredParties ?? 1;
    if (requiredParties > 1 && opts.pendingStore) {
      const partyId = body.partyData["partyId"] ?? body.partyData["name"] ?? crypto.randomUUID();

      if (body.pendingContractId) {
        // Co-signer joining an existing pending contract
        const entry = await opts.pendingStore.addParty(
          body.pendingContractId,
          partyId,
          body.partyData,
        );
        if (!entry) {
          return c.json({ error: "pendingContractId not found" }, 404);
        }

        const totalSigned = entry.acceptances.length;

        if (totalSigned >= requiredParties) {
          // All parties have signed — issue the token
          await opts.pendingStore.complete(entry.contractId);

          const now = Math.floor(Date.now() / 1000);
          const ttl = opts.ttl ?? opts.requirements.expiresIn;
          const token = await signToken(
            {
              contractId: entry.contractId,
              templateHash: opts.requirements.templateHash,
              partyId: entry.acceptances.map((a) => a.partyId).join("+"),
              resource: opts.requirements.resource,
              iat: now,
              exp: now + ttl,
            },
            opts.secret,
          );

          await opts.onAccepted?.(entry.contractId, body.partyData, body.templateHash);

          const response: AcceptResponse = {
            status: "accepted",
            contractId: entry.contractId,
            token,
          };
          return c.json(response, 200);
        }

        const response: AcceptResponse = {
          status: "pending",
          contractId: entry.contractId,
          token: "",
          pendingAcceptances: totalSigned,
          requiredAcceptances: requiredParties,
        };
        return c.json(response, 200);
      } else {
        // First signer — create the pending contract
        const contractId = crypto.randomUUID();
        const entry = await opts.pendingStore.create({
          contractId,
          templateHash: body.templateHash,
          requiredParties,
        });
        await opts.pendingStore.addParty(contractId, partyId, body.partyData);

        const response: AcceptResponse = {
          status: "pending",
          contractId: entry.contractId,
          token: "",
          pendingAcceptances: 1,
          requiredAcceptances: requiredParties,
        };
        return c.json(response, 200);
      }
    }

    // Single-party acceptance — issue token immediately
    const contractId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const ttl = opts.ttl ?? opts.requirements.expiresIn;
    const partyId = body.partyData["partyId"] ?? body.partyData["name"] ?? contractId;

    const token = await signToken(
      {
        contractId,
        templateHash: opts.requirements.templateHash,
        partyId,
        resource: opts.requirements.resource,
        iat: now,
        exp: now + ttl,
      },
      opts.secret,
    );

    await opts.onAccepted?.(contractId, body.partyData, body.templateHash);

    const response: AcceptResponse = { status: "accepted", contractId, token };
    return c.json(response, 200);
  };
}

export interface VerifyHandlerOptions {
  secret: string;
  revocationStore?: RevocationStore;
}

/**
 * Hono handler for the optional facilitator verifyEndpoint.
 *
 * Servers that don't hold the signing secret delegate token verification here.
 * Mount at ContractRequirements.verifyEndpoint.
 */
export function verifyHandler(opts: VerifyHandlerOptions): MiddlewareHandler {
  return async (c) => {
    const token = c.req.query("token");
    const resource = c.req.query("resource") ?? "*";

    if (!token) return c.json({ error: "token query param required" }, 400);

    const result = await verifyToken(token, opts.secret, resource);
    if (!result.valid) {
      return c.json({ valid: false, reason: result.reason }, 200);
    }

    if (opts.revocationStore) {
      const revoked = await opts.revocationStore.isRevoked(result.payload.contractId);
      if (revoked) {
        return c.json({ valid: false, reason: "contract revoked" }, 200);
      }
    }

    return c.json(
      {
        valid: true,
        contractId: result.payload.contractId,
        partyId: result.payload.partyId,
        expiresAt: result.payload.exp,
      },
      200,
    );
  };
}

export interface RevokeHandlerOptions {
  revocationStore: RevocationStore;
  /**
   * Optional authorization check. Return true to allow the revocation,
   * false to reject. Called before the store is updated.
   */
  onRevoke?: (contractId: string, reason?: string) => Promise<boolean>;
}

/**
 * Hono handler for ContractRequirements.revokeEndpoint.
 *
 * Accepts POST { contractId, reason? } and marks the contract revoked.
 * Subsequent requests carrying the revoked contractId will be rejected
 * by requireContract (when wired with the same RevocationStore).
 */
export function revokeHandler(opts: RevokeHandlerOptions): MiddlewareHandler {
  return async (c) => {
    const body = await c.req.json<RevokeRequest>();

    if (!body.contractId) {
      return c.json({ error: "contractId required" }, 400);
    }

    if (opts.onRevoke) {
      const allowed = await opts.onRevoke(body.contractId, body.reason);
      if (!allowed) {
        return c.json({ error: "revocation not authorized" }, 403);
      }
    }

    await opts.revocationStore.revoke(body.contractId, body.reason);

    const response: RevokeResponse = { revoked: true, contractId: body.contractId };
    return c.json(response, 200);
  };
}

export interface DiscoveryHandlerOptions {
  /** Server origin, e.g. "https://api.example.com" */
  origin: string;
  /** Resources to advertise. Each entry includes its full ContractRequirements. */
  resources: DiscoveryResource[];
}

/**
 * Hono handler for GET /.well-known/x490.
 *
 * Returns a DiscoveryDocument listing all contract gates on this server.
 * Agents fetch this once to discover all agreements they may need to establish,
 * instead of probing each path individually.
 */
export function discoveryHandler(opts: DiscoveryHandlerOptions): MiddlewareHandler {
  const doc: DiscoveryDocument = {
    scheme: "x490",
    version: 1,
    origin: opts.origin,
    resources: opts.resources,
  };
  return async (c) => c.json(doc, 200);
}
