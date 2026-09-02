import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { managers } from "./identity.js";

// WebAuthn (passkey) credentials for managers. One row per
// device a manager has registered.
//
// credentialId is the raw credential ID as base64url. Uniquely
// identifies the authenticator across the entire relying party —
// the WebAuthn spec makes it globally unique, so we can lookup by
// it alone without needing the managerId hint at authentication
// time.
//
// counter is the signature counter the authenticator reports.
// Some devices (touch id, secure enclave) always return 0; when
// non-zero it MUST be strictly greater than the stored value on
// each successful auth, else we suspect cloning and reject.
export const managerCredentials = sqliteTable(
  "manager_credentials",
  {
    id: text("id").primaryKey(),
    managerId: text("manager_id")
      .notNull()
      .references(() => managers.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports", { mode: "json" }).default("[]"),
    deviceLabel: text("device_label").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => ({
    managerIdx: index("mgr_creds_manager_idx").on(t.managerId),
  }),
);

// Ephemeral challenges for the two WebAuthn ceremonies. Each row
// is created at begin-time and consumed at verify-time (single
// use). Old rows expire after TTL and are cleaned up on
// createChallenge.
export const webauthnChallenges = sqliteTable("webauthn_challenges", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull(),
  ceremony: text("ceremony", { enum: ["register", "login"] }).notNull(),
  challenge: text("challenge").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export type ManagerCredentialRow = typeof managerCredentials.$inferSelect;
export type WebAuthnChallengeRow = typeof webauthnChallenges.$inferSelect;
