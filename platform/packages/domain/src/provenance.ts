import { z } from "zod";

// Every fact in the Life Graph carries provenance and confidence.
// See docs/22-knowledge-graph.md — this is the load-bearing
// invariant that lets us learn from action outcomes without silently
// promoting single observations to truth.

export const FactSource = z.enum([
  "customer_direct",
  "customer_document",
  "manager_observed",
  "agent_inferred_email",
  "agent_inferred_calendar",
  "agent_inferred_document",
  "agent_inferred_action_outcome",
  "integration_pull",
  "bulk_import",
]);
export type FactSource = z.infer<typeof FactSource>;

export const FactStatus = z.enum(["candidate", "confirmed", "retired"]);
export type FactStatus = z.infer<typeof FactStatus>;

export const Provenance = z.object({
  source: FactSource,
  sourceRef: z.string().optional(),
  assertedBy: z.string(),
  assertedAt: z.string().datetime(),
  confidence: z.number().min(0).max(1),
  status: FactStatus,
  supersededBy: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

// Promotion rules — candidate → confirmed happens when one of these
// is true. See knowledge-graph.md §"Learning: how facts become truth".
export const PromotionReason = z.enum([
  "customer_confirmed",
  "manager_confirmed",
  "repeated_observation",
  "action_outcome",
]);
export type PromotionReason = z.infer<typeof PromotionReason>;

export const nowIso = (): string => new Date().toISOString();
