import type { MiddlewareHandler } from "hono";
import type { ContractRequirements, AcceptRequest, AcceptResponse } from "./types.js";
import { signToken, verifyToken } from "./token.js";
import { b64encode, b64decode } from "./codec.js";

declare module "hono" {
  interface ContextVariableMap {
    lapContractId: string;
    lapPartyId: string;
  }
}

export interface ContractGateOptions {
  requirements: ContractRequirements;
  /** HMAC secret used to sign and verify tokens */
  secret: string;
}

/**
 * Hono middleware that gates a route behind a LAP contract agreement.
 *
 * Returns 403 with X-Contract-Requirements when the header is absent or invalid.
 * On success, sets c.var.lapContractId and c.var.lapPartyId.
 */
export function requireContract(opts: ContractGateOptions): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.header("X-Contract-Agreement");

    if (!raw) {
      return c.json(
        { error: "Contract agreement required", contractRequired: opts.requirements },
        403,
        { "X-Contract-Requirements": b64encode(JSON.stringify(opts.requirements)) },
      );
    }

    const result = await verifyToken(raw, opts.secret, c.req.path);
    if (!result.valid) {
      return c.json(
        { error: result.reason, contractRequired: opts.requirements },
        403,
        { "X-Contract-Requirements": b64encode(JSON.stringify(opts.requirements)) },
      );
    }

    c.set("lapContractId", result.payload.contractId);
    c.set("lapPartyId", result.payload.partyId);
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
}

/**
 * Hono handler for the acceptEndpoint.
 *
 * Mount this at the path you specified in ContractRequirements.acceptEndpoint.
 * Handles negotiation round-trips and issues signed tokens on acceptance.
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
