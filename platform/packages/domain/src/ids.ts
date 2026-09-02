import { randomUUID } from "node:crypto";

// Branded string types for identifier safety. Two distinct id types cannot
// be mixed up at the type level even though they are strings at runtime.
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type HouseholdId = Brand<string, "HouseholdId">;
export type NodeId = Brand<string, "NodeId">;
export type EdgeId = Brand<string, "EdgeId">;
export type ActionId = Brand<string, "ActionId">;
export type AuditEventId = Brand<string, "AuditEventId">;
export type PolicyId = Brand<string, "PolicyId">;
export type PrincipalId = Brand<string, "PrincipalId">;
export type ManagerId = Brand<string, "ManagerId">;

const mkId = <T extends string>(prefix: string) =>
  (): Brand<string, T> => `${prefix}_${randomUUID().replace(/-/g, "")}` as Brand<string, T>;

export const newHouseholdId = mkId<"HouseholdId">("hh");
export const newNodeId = mkId<"NodeId">("nod");
export const newEdgeId = mkId<"EdgeId">("edg");
export const newActionId = mkId<"ActionId">("act");
export const newAuditEventId = mkId<"AuditEventId">("aud");
export const newPolicyId = mkId<"PolicyId">("pol");
export const newPrincipalId = mkId<"PrincipalId">("prc");
export const newManagerId = mkId<"ManagerId">("mgr");
