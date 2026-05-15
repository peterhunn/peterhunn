-- x490 facilitator schema
-- Idempotent: all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- Run via:  DATABASE_URL=postgres://... npm run migrate  (in packages/facilitator)

CREATE TABLE IF NOT EXISTS x490_tenants (
  tenant_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  hmac_secret TEXT        NOT NULL,
  auth0_sub   TEXT        UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent migration for deployments that predate the auth0_sub column.
ALTER TABLE x490_tenants ADD COLUMN IF NOT EXISTS auth0_sub TEXT UNIQUE;

-- API keys are separate from tenants to support key rotation.
-- A tenant may have multiple active keys.
CREATE TABLE IF NOT EXISTS x490_api_keys (
  key_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  name        TEXT        NOT NULL DEFAULT 'default',
  key_hash    TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- Fast O(1) lookup by key hash (used on every authenticated request).
CREATE UNIQUE INDEX IF NOT EXISTS idx_x490_api_keys_hash
  ON x490_api_keys(key_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_x490_api_keys_tenant
  ON x490_api_keys(tenant_id);

-- Content-addressed templates: SHA-256(content) = hash = primary key.
-- Immutable once stored — updating content would change the hash.
CREATE TABLE IF NOT EXISTS x490_templates (
  hash        TEXT        PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  content     TEXT        NOT NULL,
  title       TEXT,
  description TEXT,
  terms       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent migration for deployments that predate the terms column.
ALTER TABLE x490_templates ADD COLUMN IF NOT EXISTS terms JSONB;

CREATE INDEX IF NOT EXISTS idx_x490_templates_tenant
  ON x490_templates(tenant_id);

-- Requirements config: stores expiresIn per (tenant, template, resource).
-- Upserted each time the operator calls buildRequirements.
CREATE TABLE IF NOT EXISTS x490_requirements (
  id                   UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID     NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  template_hash        TEXT     NOT NULL REFERENCES x490_templates(hash),
  resource             TEXT     NOT NULL,
  expires_in           INT      NOT NULL,
  required_party_fields TEXT[]  NOT NULL DEFAULT '{}',
  negotiable           BOOLEAN  NOT NULL DEFAULT false,
  negotiable_fields    JSONB    NOT NULL DEFAULT '[]',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, template_hash, resource)
);
-- Idempotent migrations for deployments that predate negotiable columns.
ALTER TABLE x490_requirements ADD COLUMN IF NOT EXISTS negotiable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE x490_requirements ADD COLUMN IF NOT EXISTS negotiable_fields JSONB NOT NULL DEFAULT '[]';

-- Agreements: one row per accepted contract.
CREATE TABLE IF NOT EXISTS x490_agreements (
  contract_id    TEXT        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  template_hash  TEXT        NOT NULL REFERENCES x490_templates(hash),
  party_id       TEXT        NOT NULL,
  resource       TEXT        NOT NULL,
  party_data     JSONB       NOT NULL DEFAULT '{}',
  token          TEXT        NOT NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT
);

-- Paginated listing by tenant, sorted newest first.
CREATE INDEX IF NOT EXISTS idx_x490_agreements_tenant_issued
  ON x490_agreements(tenant_id, issued_at DESC, contract_id ASC);

-- Resource filter for agreement listing.
CREATE INDEX IF NOT EXISTS idx_x490_agreements_tenant_resource
  ON x490_agreements(tenant_id, resource, issued_at DESC);

-- Fast revocation check (verify endpoint hot path).
CREATE INDEX IF NOT EXISTS idx_x490_agreements_revoked
  ON x490_agreements(contract_id)
  WHERE revoked_at IS NOT NULL;

-- Webhooks: operator-registered endpoints that receive event notifications.
CREATE TABLE IF NOT EXISTS x490_webhooks (
  webhook_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  secret      TEXT        NOT NULL,
  events      TEXT[]      NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_x490_webhooks_tenant_active
  ON x490_webhooks(tenant_id, active)
  WHERE active = true;

-- Contract event DAG: each row is a node; parent_event_ids are the incoming edges.
-- Root events (no parents) have parent_event_ids = '{}' (empty array).
CREATE TABLE IF NOT EXISTS x490_contract_events (
  event_id         TEXT        PRIMARY KEY,
  contract_id      TEXT        NOT NULL REFERENCES x490_agreements(contract_id) ON DELETE CASCADE,
  tenant_id        UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  type             TEXT        NOT NULL,
  party            TEXT,
  payload          JSONB       NOT NULL DEFAULT '{}',
  parent_event_ids TEXT[]      NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retrieve all events for an agreement in causal order.
CREATE INDEX IF NOT EXISTS idx_x490_contract_events_contract
  ON x490_contract_events(contract_id, created_at ASC);
