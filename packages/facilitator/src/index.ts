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
  AmendmentRecord,
  RequirementsConfig,
  Webhook,
  WebhookEventType,
  WebhookPayload,
} from "./types.js";

// Counterparty review page renderer (useful for custom hosting)
export { renderReviewPage } from "./review-page.js";
export type { ReviewPageOptions } from "./review-page.js";

// Integration store — maps external CLM workflow IDs to x490 templates
export { InMemoryIntegrationStore } from "./integration-store.js";
export type { IntegrationStore, IntegrationMapping } from "./integration-store.js";

// Ironclad adapter
export { IroncladClient, IroncladWebhookAdapter, verifyIroncladSignature } from "./adapters/ironclad.js";
export type {
  IroncladWorkflow,
  IroncladAttribute,
  IroncladDocument,
  IroncladWebhookEvent,
  IroncladAdapterOptions,
  IroncladWorkflowRegistered,
} from "./adapters/ironclad.js";

// DocuSign adapter
export { DocuSignClient, DocuSignWebhookAdapter, verifyDocuSignSignature } from "./adapters/docusign.js";
export type {
  DocuSignConnectEvent,
  DocuSignEnvelope,
  DocuSignSigner,
  DocuSignDocumentSummary,
  DocuSignAdapterOptions,
  DocuSignEnvelopeRegistered,
} from "./adapters/docusign.js";

// Integration config store — per-tenant credential management
export { InMemoryIntegrationConfigStore } from "./integration-config-store.js";
export type { IntegrationConfig, IntegrationConfigStore, IntegrationSource } from "./integration-config-store.js";

// Operator dashboard
export { renderDashboard } from "./dashboard.js";

// Expiry scheduler — fires contract.expiring webhook events
export { ExpiryScheduler } from "./expiry-scheduler.js";
export type { ExpirySchedulerOptions } from "./expiry-scheduler.js";
