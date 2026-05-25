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
  -- When set, events submitted with this key are automatically attributed to
  -- this party — the key is the agent's identity in the contract.
  party_id    TEXT,
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

-- Merkle-linked negotiation DAG.
--
-- Each node records one LLM decision during a contract negotiation.
-- `parent_hash` links to the previous node in the same session, forming a
-- tamper-evident chain: any edit to a prior node changes its hash and breaks
-- all descendant parent_hash references.
CREATE TABLE IF NOT EXISTS negotiation_nodes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT        NOT NULL,
  contract_id     TEXT,
  role            TEXT        NOT NULL CHECK (role IN ('client', 'server')),
  round           INT         NOT NULL,
  requirements    JSONB       NOT NULL,
  proposed_terms  JSONB,
  decision        TEXT        NOT NULL,
  reason          TEXT        NOT NULL,
  parent_hash     TEXT,
  hash            TEXT        NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_nodes_session
  ON negotiation_nodes(session_id, round ASC, created_at ASC);

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

-- Persistent delivery log — one row per delivery attempt sequence.
-- attempt_count is updated in-place after retries; succeeded_at is set on success.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id    UUID        NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL,
  status_code   INT,
  error         TEXT,
  attempt_count INT         NOT NULL DEFAULT 1,
  succeeded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
  ON webhook_deliveries(webhook_id, created_at DESC);
