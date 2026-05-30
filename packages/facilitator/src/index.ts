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
  InMemoryEventStore,
  InMemoryPendingContractStore,
  InMemoryWebhookDeliveryStore,
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
  EventStore,
  PendingContractStore,
  WebhookDeliveryStore,
} from "./store.js";

// Postgres store implementations
export {
  PostgresTenantStore,
  PostgresTemplateStore,
  PostgresAgreementStore,
  PostgresRequirementsStore,
  PostgresWebhookStore,
  PostgresEventStore,
  PostgresPendingContractStore,
  PostgresWebhookDeliveryStore,
} from "./store-postgres.js";

// Webhook delivery helper (for custom integrations)
export { signWebhookPayload, deliverWebhookEvent } from "./webhook.js";

// Webhook retry worker — persistent retry with exponential backoff
export { WebhookRetryWorker } from "./webhook-retry-worker.js";
export type { WebhookRetryWorkerOptions } from "./webhook-retry-worker.js";

// Client SDK — for server operators integrating with the managed service
export { FacilitatorClient, signUp } from "./client.js";
export type {
  FacilitatorClientOptions,
  UploadResult,
  TemplateSummary,
  TemplatePage,
  AgreementPage,
  EventPage,
  AmendResult,
  RenewResult,
  StatsResult,
  HealthResult,
} from "./client.js";

// Types
export type {
  Tenant,
  TenantApiKey,
  RegisteredTemplate,
  AgreementRecord,
  AmendmentRecord,
  ContractEventRecord,
  RequirementsConfig,
  Webhook,
  WebhookDelivery,
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

// Postgres integration config store
export { PostgresIntegrationConfigStore } from "./integration-config-store-postgres.js";

// Operator dashboard
export { renderDashboard } from "./dashboard.js";

// Expiry scheduler — fires contract.expiring webhook events
export { ExpiryScheduler } from "./expiry-scheduler.js";
export type { ExpirySchedulerOptions } from "./expiry-scheduler.js";

// Document extraction — PDF and DOCX → plain text for template registration
export { extractDocumentText } from "./document-extractor.js";
export type { DocumentExtractResult } from "./document-extractor.js";
