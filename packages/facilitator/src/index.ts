// Server — embed the facilitator in your own Hono app
export { createFacilitatorApp } from "./app.js";
export type { FacilitatorAppOptions } from "./app.js";

// Stores — swap in-memory for Postgres in production
export {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
  sha256hex,
  encodeCursor,
  decodeCursor,
} from "./store.js";
export type {
  TenantStore,
  TemplateStore,
  AgreementStore,
  RequirementsStore,
  WebhookStore,
} from "./store.js";

// Postgres store implementations
export {
  PostgresTenantStore,
  PostgresTemplateStore,
  PostgresAgreementStore,
  PostgresRequirementsStore,
  PostgresWebhookStore,
} from "./store-postgres.js";

// Webhook delivery helper (for custom integrations)
export { signWebhookPayload, deliverWebhookEvent } from "./webhook.js";

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
  Webhook,
  WebhookEventType,
  WebhookPayload,
} from "./types.js";
