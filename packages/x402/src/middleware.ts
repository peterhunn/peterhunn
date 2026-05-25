import type { MiddlewareHandler } from "hono";
import type { PaymentProof, PaymentRequirements } from "./types.js";
import { encodeRequirements, decodeProof } from "./codec.js";
import { verifyPaymentOffline } from "./verify.js";

export interface PaymentMiddlewareOptions {
  requirements: PaymentRequirements;
  /**
   * Verify a payment proof. Return true if valid.
   * Defaults to a signature-format check (not on-chain) — suitable for testing.
   * Replace with an on-chain verifier for production.
   */
  verify?: (proof: PaymentProof, requirements: PaymentRequirements) => Promise<boolean>;
}

export function requirePayment(opts: PaymentMiddlewareOptions): MiddlewareHandler {
  const { requirements } = opts;
  const verify = opts.verify ?? verifyPaymentOffline;
  const encodedRequirements = encodeRequirements(requirements);

  return async (c, next) => {
    const paymentHeader = c.req.header("X-Payment");

    if (!paymentHeader) {
      return c.json(
        { error: "payment_required", requirements },
        402,
        { "X-Payment-Required": encodedRequirements },
      );
    }

    let proof: PaymentProof;
    try {
      proof = decodeProof(paymentHeader);
    } catch {
      return c.json(
        { error: "payment_required", requirements },
        402,
        { "X-Payment-Required": encodedRequirements },
      );
    }

    const valid = await verify(proof, requirements);
    if (!valid) {
      return c.json(
        { error: "payment_invalid" },
        402,
        { "X-Payment-Required": encodedRequirements },
      );
    }

    await next();
  };
}
