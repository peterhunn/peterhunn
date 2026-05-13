// Server — embed the facilitator in your own Hono app
export { createFacilitatorApp } from "./app.js";
export type { FacilitatorAppOptions } from "./app.js";

// Stores — swap in-memory for Postgres in production
export {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
} from "./store.js";
export type { TenantStore, TemplateStore, AgreementStore } from "./store.js";

// Client SDK — for server operators integrating with the managed service
export { FacilitatorClient, signUp } from "./client.js";
export type { FacilitatorClientOptions } from "./client.js";

// Types
export type { Tenant, RegisteredTemplate, AgreementRecord } from "./types.js";
