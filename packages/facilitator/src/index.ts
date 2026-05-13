// Server — embed the facilitator in your own Hono app
export { createFacilitatorApp } from "./app.js";
export type { FacilitatorAppOptions } from "./app.js";

// Stores — swap in-memory for Postgres in production
export {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  sha256hex,
  encodeCursor,
  decodeCursor,
} from "./store.js";
export type {
  TenantStore,
  TemplateStore,
  AgreementStore,
  RequirementsStore,
} from "./store.js";

// Postgres store implementations
export {
  PostgresTenantStore,
  PostgresTemplateStore,
  PostgresAgreementStore,
  PostgresRequirementsStore,
} from "./store-postgres.js";

// Client SDK — for server operators integrating with the managed service
export { FacilitatorClient, signUp } from "./client.js";
export type { FacilitatorClientOptions } from "./client.js";

// Types
export type {
  Tenant,
  TenantApiKey,
  RegisteredTemplate,
  AgreementRecord,
  RequirementsConfig,
} from "./types.js";
