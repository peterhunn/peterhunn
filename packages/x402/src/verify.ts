import type { PaymentProof, PaymentRequirements } from "./types.js";

/**
 * Default (offline) verifier — checks structure and basic constraints only.
 * Swap for an on-chain verifier in production.
 */
export async function verifyPaymentOffline(
  proof: PaymentProof,
  requirements: PaymentRequirements,
): Promise<boolean> {
  // Network must match
  if (proof.network !== requirements.network) {
    return false;
  }

  // Payment value must be >= required amount
  try {
    if (BigInt(proof.payload.authorization.value) < BigInt(requirements.maxAmountRequired)) {
      return false;
    }
  } catch {
    return false;
  }

  // Recipient address must match (case-insensitive)
  if (
    proof.payload.authorization.to.toLowerCase() !==
    requirements.payTo.toLowerCase()
  ) {
    return false;
  }

  // Signature must be a valid 65-byte 0x-prefixed hex string (130 hex chars after 0x)
  if (!/^0x[0-9a-f]{130}$/i.test(proof.payload.signature)) {
    return false;
  }

  // Authorization must not be expired
  const validBefore = Number(proof.payload.authorization.validBefore);
  if (validBefore <= Date.now() / 1000) {
    return false;
  }

  return true;
}
