import { sqliteTable, text, index, primaryKey } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Managers — internal employees of the company. Distinct from
// customers, agents, and system callers.
export const managers = sqliteTable("managers", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull().unique(),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
});

// API tokens — phase-0 bearer token surface. Real auth (passkeys, SSO)
// replaces this later; the token → actor mapping stays.
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    actorType: text("actor_type", {
      enum: ["customer", "manager", "agent", "system"],
    }).notNull(),
    actorId: text("actor_id").notNull(),
    label: text("label").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    expiresAt: text("expires_at"),
  },
  (t) => ({
    actorIdx: index("api_tokens_actor_idx").on(t.actorType, t.actorId),
  }),
);

// Manager → household grants. A manager may only see households on
// which they hold a live grant.
export const householdGrants = sqliteTable(
  "household_grants",
  {
    managerId: text("manager_id")
      .notNull()
      .references(() => managers.id, { onDelete: "cascade" }),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["primary", "backup", "covering", "readonly"] }).notNull(),
    grantedAt: text("granted_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.managerId, t.householdId] }),
    householdIdx: index("household_grants_household_idx").on(t.householdId),
  }),
);

export type ManagerRow = typeof managers.$inferSelect;
export type NewManagerRow = typeof managers.$inferInsert;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type NewApiTokenRow = typeof apiTokens.$inferInsert;
export type HouseholdGrantRow = typeof householdGrants.$inferSelect;
