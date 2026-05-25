export interface PaymentRequirements {
  version: 1;
  scheme: "exact";
  network: string;           // e.g. "base", "base-sepolia", "ethereum"
  maxAmountRequired: string; // decimal string, smallest unit (e.g. "1000000" = 1 USDC)
  resource: string;          // the path being protected, e.g. "/api/data"
  description: string;
  mimeType?: string;
  payTo: string;             // recipient address 0x...
  maxTimeoutSeconds: number;
  asset: string;             // token contract address 0x...
  extra?: {
    name: string;            // e.g. "USDC"
    decimals: number;        // e.g. 6
  };
}

export interface PaymentAuthorization {
  from: string;              // payer address 0x...
  to: string;                // payTo address
  value: string;             // decimal string, same unit as maxAmountRequired
  validAfter: string;        // unix seconds as string
  validBefore: string;       // unix seconds as string
  nonce: string;             // 0x-prefixed hex bytes32
}

export interface PaymentProof {
  x402Version: 1;
  scheme: "exact";
  network: string;
  payload: {
    signature: string;       // 0x-prefixed EIP-712 sig of the authorization
    authorization: PaymentAuthorization;
  };
}

// What the server sends back on 402
export interface X402Challenge {
  error: "payment_required";
  requirements: PaymentRequirements;
}
