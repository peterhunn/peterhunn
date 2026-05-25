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
  parent_hash TEXT        REFERENCES x490_templates(hash),
  change_note TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent migrations for deployments that predate these columns.
ALTER TABLE x490_templates ADD COLUMN IF NOT EXISTS terms JSONB;
ALTER TABLE x490_templates ADD COLUMN IF NOT EXISTS parent_hash TEXT REFERENCES x490_templates(hash);
ALTER TABLE x490_templates ADD COLUMN IF NOT EXISTS change_note TEXT;

-- Version lineage index: find children of a given template version.
CREATE INDEX IF NOT EXISTS idx_x490_templates_parent
  ON x490_templates(parent_hash)
  WHERE parent_hash IS NOT NULL;

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
  required_parties     INT      NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, template_hash, resource)
);
-- Idempotent migrations for deployments that predate negotiable columns.
ALTER TABLE x490_requirements ADD COLUMN IF NOT EXISTS negotiable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE x490_requirements ADD COLUMN IF NOT EXISTS negotiable_fields JSONB NOT NULL DEFAULT '[]';
ALTER TABLE x490_requirements ADD COLUMN IF NOT EXISTS required_parties INT NOT NULL DEFAULT 1;

-- Idempotent migrations for EVM optional fields on agreements.
ALTER TABLE x490_agreements ADD COLUMN IF NOT EXISTS wallet_address      TEXT;
ALTER TABLE x490_agreements ADD COLUMN IF NOT EXISTS eip712_credential   TEXT;
ALTER TABLE x490_agreements ADD COLUMN IF NOT EXISTS nft_token_id        TEXT;
ALTER TABLE x490_agreements ADD COLUMN IF NOT EXISTS nft_tx_hash         TEXT;
ALTER TABLE x490_agreements ADD COLUMN IF NOT EXISTS external_source      TEXT;
ALTER TABLE x490_agreements ADD COLUMN IF NOT EXISTS external_id          TEXT;
ALTER TABLE x490_agreements ADD COLUMN IF NOT EXISTS parent_contract_id   TEXT;
ALTER TABLE x490_agreements ADD COLUMN IF NOT EXISTS warned_at             TIMESTAMPTZ;

-- Agreements: one row per accepted contract.
CREATE TABLE IF NOT EXISTS x490_agreements (
  contract_id       TEXT        PRIMARY KEY,
  tenant_id         UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  template_hash     TEXT        NOT NULL REFERENCES x490_templates(hash),
  party_id          TEXT        NOT NULL,
  resource          TEXT        NOT NULL,
  party_data        JSONB       NOT NULL DEFAULT '{}',
  token             TEXT        NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT,
  -- Optional EVM fields — populated when walletAddress is present in partyData
  wallet_address    TEXT,
  eip712_credential TEXT,
  nft_token_id      TEXT,
  nft_tx_hash       TEXT,
  -- External CLM source tracking (DocuSign, Salesforce, etc.)
  external_source   TEXT,
  external_id       TEXT,
  -- Renewal chain: references the contractId this agreement renews
  parent_contract_id TEXT,
  -- Set by ExpiryScheduler after warning delivery; prevents re-delivery on restart
  warned_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_x490_agreements_external
  ON x490_agreements(tenant_id, external_source, external_id)
  WHERE external_source IS NOT NULL;

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

-- Cross-contract audit log: list all events for a tenant (compliance/GDPR use case).
CREATE INDEX IF NOT EXISTS idx_x490_contract_events_tenant
  ON x490_contract_events(tenant_id, created_at ASC, event_id ASC);

-- Pending multi-party contracts: accumulates acceptances until all required parties sign.
CREATE TABLE IF NOT EXISTS x490_pending_contracts (
  contract_id      TEXT        PRIMARY KEY,
  tenant_id        UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  template_hash    TEXT        NOT NULL,
  required_parties INT         NOT NULL DEFAULT 2,
  acceptances      JSONB       NOT NULL DEFAULT '[]',
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_x490_pending_contracts_tenant
  ON x490_pending_contracts(tenant_id, created_at DESC);

-- Webhook delivery log: records each delivery attempt and its outcome.
CREATE TABLE IF NOT EXISTS x490_webhook_deliveries (
  delivery_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id    UUID        NOT NULL REFERENCES x490_webhooks(webhook_id) ON DELETE CASCADE,
  tenant_id     UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL,
  contract_id   TEXT,
  status_code   INT,
  error         TEXT,
  attempt_count INT         NOT NULL DEFAULT 1,
  succeeded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_x490_webhook_deliveries_webhook
  ON x490_webhook_deliveries(webhook_id, created_at DESC);

-- Amendments: records each modification to an in-force agreement.
-- The agreement row is also updated (token, expires_at) on each amendment.
CREATE TABLE IF NOT EXISTS x490_amendments (
  amendment_id    TEXT        PRIMARY KEY,
  contract_id     TEXT        NOT NULL REFERENCES x490_agreements(contract_id) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  amended_by      TEXT        NOT NULL,
  reason          TEXT,
  changes         JSONB       NOT NULL DEFAULT '{}',
  token           TEXT        NOT NULL,
  previous_token  TEXT        NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x490_amendments_contract
  ON x490_amendments(contract_id, issued_at ASC);

-- Expiry index: efficiently find agreements expiring in a time window.
CREATE INDEX IF NOT EXISTS idx_x490_agreements_expiry
  ON x490_agreements(expires_at ASC)
  WHERE revoked_at IS NULL AND warned_at IS NULL;

-- Integration configs: per-tenant CLM platform credentials.
CREATE TABLE IF NOT EXISTS x490_integration_configs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES x490_tenants(tenant_id) ON DELETE CASCADE,
  source        TEXT        NOT NULL,
  credentials   JSONB       NOT NULL DEFAULT '{}',
  webhook_secret TEXT       NOT NULL,
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source)
);

-- Renewal chain index: find all renewals of a given agreement.
CREATE INDEX IF NOT EXISTS idx_x490_agreements_parent
  ON x490_agreements(parent_contract_id)
  WHERE parent_contract_id IS NOT NULL;
