import { z } from "zod";
import type { ManagerId, HouseholdId } from "./ids.js";

// The three identity types that call the API. See ../life-management/
// data-model.md §"Identity". A fourth type (delegated) exists on the
// tool boundary when acting on the customer's behalf against third
// parties — it does not authenticate to our own API.
export const ActorType = z.enum(["customer", "manager", "agent", "system"]);
export type ActorType = z.infer<typeof ActorType>;

export interface Manager {
  readonly id: ManagerId;
  readonly displayName: string;
  readonly email: string;
  readonly createdAt: string;
  readonly archivedAt: string | undefined;
}

export const HouseholdGrantRole = z.enum([
  "primary",
  "backup",
  "covering",
  "readonly",
]);
export type HouseholdGrantRole = z.infer<typeof HouseholdGrantRole>;

export interface HouseholdGrant {
  readonly managerId: ManagerId;
  readonly householdId: HouseholdId;
  readonly role: HouseholdGrantRole;
  readonly grantedAt: string;
  readonly revokedAt: string | undefined;
}

// The resolved actor attached to every authenticated request.
export interface Actor {
  readonly type: ActorType;
  readonly id: string;
  readonly displayName: string;
  readonly householdIds: readonly HouseholdId[];
}
