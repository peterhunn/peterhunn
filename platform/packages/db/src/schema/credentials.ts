import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Delegated credentials — OAuth tokens and other secrets the platform
// holds on the customer's behalf. Encrypted-at-rest per household in
// production (see ../life-management/data-model.md §Keys and
// encryption); phase 0 stores tokens in plaintext SQLite for local
// dev velocity — do NOT ship this to production without wrapping
// `credential` in a KMS-backed envelope.
export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),

    provider: text("provider").notNull(), // google_calendar | gmail | twilio | stripe ...
    kind: text("kind", { enum: ["oauth2", "api_key", "token", "other"] }).notNull(),
    label: text("label").notNull(),
    principalRef: text("principal_ref"), // which household member the credential is for

    credential: text("credential", { mode: "json" }).notNull(),
    scopes: text("scopes", { mode: "json" }).notNull().default("[]"),

    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    lastUsedAt: text("last_used_at"),
  },
  (t) => ({
    householdProviderIdx: index("credentials_household_provider_idx").on(
      t.householdId,
      t.provider,
    ),
    householdIdx: index("credentials_household_idx").on(t.householdId),
  }),
);

export type CredentialRow = typeof credentials.$inferSelect;
export type NewCredentialRow = typeof credentials.$inferInsert;
