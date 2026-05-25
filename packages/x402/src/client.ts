import type { PaymentProof, PaymentRequirements } from "./types.js";
import { decodeRequirements, encodeProof } from "./codec.js";

export interface X402ClientOptions {
  /**
   * Called when a 402 is received. Must return a PaymentProof.
   * In production this signs an EIP-3009 authorization with the user's wallet.
   */
  pay: (requirements: PaymentRequirements) => Promise<PaymentProof>;
  /** Max retries after payment. Default 1. */
  maxRetries?: number;
}

export class X402Client {
  constructor(private readonly opts: X402ClientOptions) {}

  /** Fetch with automatic 402 handling. */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const maxRetries = this.opts.maxRetries ?? 1;

    let response = await globalThis.fetch(url, init);

    if (response.status !== 402) {
      return response;
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const paymentRequiredHeader = response.headers.get("X-Payment-Required");
      if (!paymentRequiredHeader) {
        throw new Error("402 response missing X-Payment-Required header");
      }

      const requirements = decodeRequirements(paymentRequiredHeader);
      const proof = await this.opts.pay(requirements);
      const encodedProof = encodeProof(proof);

      const retryInit: RequestInit = {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          "X-Payment": encodedProof,
        },
      };

      response = await globalThis.fetch(url, retryInit);

      if (response.status !== 402) {
        return response;
      }
    }

    throw new Error(`Payment failed after ${maxRetries} retries`);
  }
}
