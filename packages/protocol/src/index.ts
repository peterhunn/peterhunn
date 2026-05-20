export type {
  NegotiableField,
  ContractRequirements,
  AgreementPayload,
  AgreementToken,
  AcceptRequest,
  AcceptResponse,
  VerifyRequest,
  VerifyResponse,
  RevokeRequest,
  RevokeResponse,
  DiscoveryResource,
  DiscoveryDocument,
  X402PaymentRequirement,
  X402Response,
} from "./types.js";

export { signToken, verifyToken, decodeToken } from "./token.js";
export type { VerifyOk, VerifyFail } from "./token.js";

export {
  requireContract,
  requireContractFetch,
  requireContractExpress,
  acceptHandler,
  verifyHandler,
  revokeHandler,
  discoveryHandler,
} from "./middleware.js";
export type {
  ContractGateOptions,
  AcceptHandlerOptions,
  VerifyHandlerOptions,
  RevokeHandlerOptions,
  DiscoveryHandlerOptions,
  FetchContractResult,
  ExpressLikeRequest,
  ExpressLikeResponse,
  ExpressNextFunction,
} from "./middleware.js";

export { InMemoryRevocationStore } from "./revocation.js";
export type { RevocationStore } from "./revocation.js";

export { InMemoryPendingContractStore } from "./pending.js";
export type { PendingContractStore, PendingEntry } from "./pending.js";

export { ContractClient } from "./client.js";
export type { ContractClientOptions } from "./client.js";

export {
  buildX402WithContract,
  parseX402Response,
  x490ExtensionHeaders,
  extractContractRequirements,
} from "./x402.js";
