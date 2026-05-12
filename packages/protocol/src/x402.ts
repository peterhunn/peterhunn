import type {
  ContractRequirements,
  X402PaymentRequirement,
  X402Response,
} from "./types.js";
import { b64encode, b64decode } from "./codec.js";

/**
 * Build a combined x402 + x451 402 response body.
 *
 * Servers that require both payment and a legal agreement call this instead
 * of returning a bare x402 body. x402-only clients ignore the unknown
 * contractRequired field; x451-aware clients process both gates.
 */
export function buildX402WithContract(
  paymentRequirements: X402PaymentRequirement[],
  contractRequired: ContractRequirements,
): X402Response {
  return {
    x402Version: 1,
    accepts: paymentRequirements,
    contractRequired,
    error: null,
  };
}

/**
 * Parse a raw 402 response body, returning the x402 fields and any
 * embedded x451 ContractRequirements.
 */
export function parseX402Response(body: unknown): X402Response {
  const r = body as Record<string, unknown>;
  return {
    x402Version: 1,
    accepts: (r["accepts"] as X402PaymentRequirement[]) ?? [],
    ...(r["contractRequired"] !== undefined
      ? { contractRequired: r["contractRequired"] as ContractRequirements }
      : {}),
    error: (r["error"] as string | null) ?? null,
  };
}

/**
 * Additional response headers to include alongside a 402 that carries x451 requirements.
 *
 * Allows clients that check headers (not the body) to discover the contract gate.
 */
export function x451ExtensionHeaders(
  contractRequired: ContractRequirements,
): Record<string, string> {
  return {
    "X-451-Requirements": b64encode(JSON.stringify(contractRequired)),
  };
}

/**
 * Given a fetch Response that returned 402, extract any embedded x451
 * ContractRequirements from the body or X-451-Requirements header.
 *
 * Returns undefined if this is a plain x402 response with no x451 layer.
 */
export async function extractContractRequirements(
  response: Response,
): Promise<ContractRequirements | undefined> {
  const header = response.headers.get("X-451-Requirements");
  if (header) {
    try {
      return JSON.parse(b64decode(header)) as ContractRequirements;
    } catch {
      // fall through to body parse
    }
  }

  try {
    const body = parseX402Response(await response.clone().json());
    return body.contractRequired;
  } catch {
    return undefined;
  }
}
