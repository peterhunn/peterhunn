export type {
  NegotiableField,
  ContractRequirements,
  AgreementPayload,
  AgreementToken,
  AcceptRequest,
  AcceptResponse,
  VerifyRequest,
  VerifyResponse,
  X402PaymentRequirement,
  X402Response,
} from "./types.js";

export { signToken, verifyToken, decodeToken } from "./token.js";
export type { VerifyOk, VerifyFail } from "./token.js";

export { requireContract, acceptHandler, verifyHandler } from "./middleware.js";
export type {
  ContractGateOptions,
  AcceptHandlerOptions,
  VerifyHandlerOptions,
} from "./middleware.js";

export { ContractClient } from "./client.js";
export type { ContractClientOptions } from "./client.js";

export {
  buildX402WithContract,
  parseX402Response,
  x451ExtensionHeaders,
  extractContractRequirements,
} from "./x402.js";
