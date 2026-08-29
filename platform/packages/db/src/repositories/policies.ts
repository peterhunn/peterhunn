import { and, eq, isNull, inArray, desc } from "drizzle-orm";
import {
  newPolicyId,
  nowIso,
  AUTONOMY_RANK,
  type Policy,
  type PolicySpec,
  type PolicyId,
  type PolicySuggestionLineage,
  type HouseholdId,
  type Domain,
  type Provenance,
} from "@atelier/domain";
import type { Db } from "../client.js";
import { policies, type PolicyRow } from "../schema/policies.js";

const toPolicy = (row: PolicyRow): Policy => ({
  id: row.id as PolicyId,
  householdId: row.householdId as HouseholdId,
  spec: row.spec as PolicySpec,
  provenance: {
    source: row.provenanceSource as Provenance["source"],
    assertedBy: row.provenanceAssertedBy,
    assertedAt: row.provenanceAssertedAt,
    confidence: row.provenanceConfidence,
  },
  createdAt: row.createdAt,
  revokedAt: row.revokedAt ?? undefined,
  consumedByActionId: (row.consumedByActionId ?? undefined) as
    | Policy["consumedByActionId"]
    | undefined,
  suggestionLineage:
    (row.suggestionLineage as PolicySuggestionLineage | null) ?? undefined,
});

export interface CreatePolicyInput {
  readonly householdId: HouseholdId;
  readonly spec: PolicySpec;
  readonly provenance: {
    readonly source: Provenance["source"];
    readonly assertedBy: string;
    readonly confidence: number;
  };
  // Populated when the policy is created by adopting an
  // autonomy-ladder suggestion. Stored verbatim on the row so an
  // auditor can walk back to the basis approvals or the demoted
  // execute policy without re-computing the suggestion.
  readonly suggestionLineage?: PolicySuggestionLineage;
}

export const policyRepo = (db: Db) => ({
  create(input: CreatePolicyInput): Policy {
    const id = newPolicyId();
    const now = nowIso();
    db.insert(policies)
      .values({
        id,
        householdId: input.householdId,
        subject: input.spec.subject,
        domain: input.spec.domain,
        actionClass: input.spec.actionClass,
        effect: input.spec.effect,
        kind: input.spec.kind,
        autonomyRank: AUTONOMY_RANK[input.spec.autonomy],
        label: input.spec.label,
        spec: input.spec,
        provenanceSource: input.provenance.source,
        provenanceAssertedBy: input.provenance.assertedBy,
        provenanceAssertedAt: now,
        provenanceConfidence: input.provenance.confidence,
        createdAt: now,
        suggestionLineage: input.suggestionLineage ?? null,
      })
      .run();
    const row = db.select().from(policies).where(eq(policies.id, id)).get();
    if (!row) throw new Error("policy insert did not return");
    return toPolicy(row);
  },

  // Load the candidate policy set for evaluation. Match by household +
  // domain + action_class + subject (specific subject OR any_principal).
  // Filtering by window and scope happens in the engine.
  match(input: {
    householdId: HouseholdId;
    domain: Domain;
    actionClass: string;
    subjectPrincipalId: string;
  }): Policy[] {
    const subjectCandidates = [input.subjectPrincipalId, "any_principal"];
    const rows = db
      .select()
      .from(policies)
      .where(
        and(
          eq(policies.householdId, input.householdId),
          eq(policies.domain, input.domain),
          eq(policies.actionClass, input.actionClass),
          inArray(policies.subject, subjectCandidates),
          isNull(policies.revokedAt),
          isNull(policies.consumedByActionId),
        ),
      )
      .all();
    return rows.map(toPolicy);
  },

  list(householdId: HouseholdId): Policy[] {
    const rows = db
      .select()
      .from(policies)
      .where(and(eq(policies.householdId, householdId), isNull(policies.revokedAt)))
      .orderBy(desc(policies.createdAt))
      .all();
    return rows.map(toPolicy);
  },

  revoke(id: PolicyId): void {
    db.update(policies).set({ revokedAt: nowIso() }).where(eq(policies.id, id)).run();
  },

  consume(id: PolicyId, actionId: string): void {
    db.update(policies)
      .set({ consumedByActionId: actionId })
      .where(eq(policies.id, id))
      .run();
  },
});
