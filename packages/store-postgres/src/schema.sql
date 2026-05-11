-- Legal Agents schema
-- Run via: npm run migrate  (packages/store-postgres)
-- Idempotent: all statements use IF NOT EXISTS / DO NOTHING.

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  key_hash    TEXT        NOT NULL UNIQUE,
  mode        TEXT        NOT NULL CHECK (mode IN ('live', 'test')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys(org_id);

CREATE TABLE IF NOT EXISTS contracts (
  id            UUID        PRIMARY KEY,
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_type TEXT        NOT NULL,
  data          JSONB       NOT NULL,
  state         JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contracts_org_id ON contracts(org_id);

-- Merkle DAG audit log.
--
-- Each row carries:
--   hash         — sha256 of canonical({ id, orgId, keyId, contractId, action,
--                                        payload, parentHashes, createdAt })
--   parent_hashes — hashes of all entries that were tips at insert time
--
-- Invariants:
--   • Modifying any column changes `hash`, breaking every descendant's
--     parent_hashes reference — detectable by verify().
--   • Deleting a row leaves a gap in parent_hashes — detectable by verify().
--   • Two concurrent inserts both reference the same tips and become co-tips
--     (true DAG, not just a linear chain).
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_id        UUID        REFERENCES api_keys(id) ON DELETE SET NULL,
  contract_id   UUID        REFERENCES contracts(id) ON DELETE SET NULL,
  action        TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}',
  parent_hashes TEXT[]      NOT NULL DEFAULT '{}',
  hash          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_hash ON audit_log(hash);
CREATE INDEX IF NOT EXISTS idx_audit_log_org_contract
  ON audit_log(org_id, contract_id, created_at DESC);

-- Efficient tip tracking for the Merkle DAG.
--
-- `scope` is the contract_id as text, or the empty string for org-level entries.
-- On each insert: remove consumed parent hashes, add the new hash as the sole tip.
-- Maintained transactionally alongside audit_log inserts.
CREATE TABLE IF NOT EXISTS audit_log_tips (
  org_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope   TEXT NOT NULL,
  hash    TEXT NOT NULL,
  PRIMARY KEY (org_id, scope, hash)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  secret      TEXT        NOT NULL,
  events      TEXT[]      NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_org_id ON webhooks(org_id);

-- Persistent delivery log for retry infrastructure.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id    UUID        NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts      INT         NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_retry_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON webhook_deliveries(next_retry_at)
  WHERE status = 'pending';
