import { z } from "zod";
import type {
  HouseholdId,
  NodeId,
  EdgeId,
  ActionId,
} from "./ids.js";
import { Provenance, nowIso } from "./provenance.js";
import {
  isKnownNodeType,
  parseNodeData,
  type NodeType,
} from "./entities.js";
import { EdgeType, EdgeAttrs } from "./relationships.js";

// A fully-typed node as returned from and accepted by the domain layer.
// The `data` blob is validated against the schema for `type` at parse
// time; the on-disk representation stores `data` as JSON.
export interface Node {
  readonly id: NodeId;
  readonly householdId: HouseholdId;
  readonly type: NodeType;
  readonly data: unknown;
  readonly provenance: Provenance;
  readonly createdAt: string;
  readonly supersededAt: string | undefined;
}

export interface Edge {
  readonly id: EdgeId;
  readonly householdId: HouseholdId;
  readonly type: EdgeType;
  readonly fromNodeId: NodeId;
  readonly toNodeId: NodeId;
  readonly attrs: EdgeAttrs;
  readonly provenance: Provenance;
  readonly createdAt: string;
  readonly supersededAt: string | undefined;
}

// A candidate submission is what agents and managers propose. It becomes
// a Node once parsed and assigned an id / timestamps. The provenance
// determines whether it enters as `candidate` or `confirmed`.
export const NodeCandidate = z.object({
  type: z.string(),
  data: z.unknown(),
  provenance: Provenance,
});
export type NodeCandidate = z.infer<typeof NodeCandidate>;

export const EdgeCandidate = z.object({
  type: EdgeType,
  fromNodeId: z.string(),
  toNodeId: z.string(),
  attrs: EdgeAttrs.default({}),
  provenance: Provenance,
});
export type EdgeCandidate = z.infer<typeof EdgeCandidate>;

// Validate a candidate node against the ontology; throws on unknown
// type or on data failing the type's schema.
export const validateNodeCandidate = (c: NodeCandidate): { type: NodeType; data: unknown } => {
  if (!isKnownNodeType(c.type)) {
    throw new OntologyError(`Unknown node type: ${c.type}`);
  }
  const type = c.type;
  const data = parseNodeData(type, c.data);
  return { type, data };
};

export class OntologyError extends Error {
  override readonly name = "OntologyError" as const;
}

// Household — the tenancy boundary. See docs/23-data-model.md.
export interface Household {
  readonly id: HouseholdId;
  readonly name: string;
  readonly tier: HouseholdTier;
  readonly riskTier: HouseholdRiskTier;
  readonly createdAt: string;
}

export const HouseholdTier = z.enum(["life", "executive", "private"]);
export type HouseholdTier = z.infer<typeof HouseholdTier>;

export const HouseholdRiskTier = z.enum(["standard", "elevated", "hnw"]);
export type HouseholdRiskTier = z.infer<typeof HouseholdRiskTier>;

// Action ledger — every material action, with its authority trail.
// See docs/33-permissions-and-autonomy.md §"Audit".
export interface ActionRecord {
  readonly id: ActionId;
  readonly householdId: HouseholdId;
  readonly agent: string;
  readonly agentVersion: string;
  readonly tool: string;
  readonly toolVersion: string;
  readonly inputsHash: string;
  readonly outputsHash: string | undefined;
  readonly policyIdAuthorizing: string | undefined;
  readonly approverId: string | undefined;
  readonly approvalChannel: string | undefined;
  readonly outcome: ActionOutcome;
  readonly summary: string;
  readonly createdAt: string;
  readonly completedAt: string | undefined;
}

export const ActionOutcome = z.enum([
  "planned",
  "in_flight",
  "succeeded",
  "failed_transient",
  "failed_permanent",
  "rolled_back",
]);
export type ActionOutcome = z.infer<typeof ActionOutcome>;

export { nowIso };
