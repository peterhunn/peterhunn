import { and, eq, isNull } from "drizzle-orm";
import {
  newNodeId,
  newEdgeId,
  nowIso,
  validateNodeCandidate,
  type EdgeCandidate,
  type NodeCandidate,
  type Node,
  type Edge,
  type NodeId,
  type EdgeId,
  type HouseholdId,
  type NodeType,
  type EdgeType,
  type Provenance,
} from "@atelier/domain";
import type { Db } from "../client.js";
import { nodes, type NodeRow } from "../schema/nodes.js";
import { edges, type EdgeRow } from "../schema/edges.js";

const provenanceFromRow = (r: NodeRow | EdgeRow): Provenance => ({
  source: r.provenanceSource as Provenance["source"],
  ...(r.provenanceSourceRef !== null && { sourceRef: r.provenanceSourceRef }),
  assertedBy: r.provenanceAssertedBy,
  assertedAt: r.provenanceAssertedAt,
  confidence: r.provenanceConfidence,
  status: r.provenanceStatus,
  ...(r.supersededBy !== null && { supersededBy: r.supersededBy }),
});

const nodeFromRow = (r: NodeRow): Node => ({
  id: r.id as NodeId,
  householdId: r.householdId as HouseholdId,
  type: r.type as NodeType,
  data: r.data,
  provenance: provenanceFromRow(r),
  createdAt: r.createdAt,
  supersededAt: r.supersededAt ?? undefined,
});

const edgeFromRow = (r: EdgeRow): Edge => ({
  id: r.id as EdgeId,
  householdId: r.householdId as HouseholdId,
  type: r.type as EdgeType,
  fromNodeId: r.fromNodeId as NodeId,
  toNodeId: r.toNodeId as NodeId,
  attrs: (r.attrs ?? {}) as Record<string, unknown>,
  provenance: provenanceFromRow(r),
  createdAt: r.createdAt,
  supersededAt: r.supersededAt ?? undefined,
});

export const graphRepo = (db: Db) => ({
  createNode(householdId: HouseholdId, candidate: NodeCandidate): Node {
    const parsed = validateNodeCandidate(candidate);
    const id = newNodeId();
    db.insert(nodes)
      .values({
        id,
        householdId,
        type: parsed.type,
        data: parsed.data,
        provenanceSource: candidate.provenance.source,
        provenanceSourceRef: candidate.provenance.sourceRef ?? null,
        provenanceAssertedBy: candidate.provenance.assertedBy,
        provenanceAssertedAt: candidate.provenance.assertedAt,
        provenanceConfidence: candidate.provenance.confidence,
        provenanceStatus: candidate.provenance.status,
        createdAt: nowIso(),
      })
      .run();
    const row = db.select().from(nodes).where(eq(nodes.id, id)).get();
    if (!row) throw new Error("node insert did not return");
    return nodeFromRow(row);
  },

  getNode(householdId: HouseholdId, id: NodeId): Node | null {
    const row = db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.id, id),
          eq(nodes.householdId, householdId),
          isNull(nodes.supersededAt),
        ),
      )
      .get();
    return row ? nodeFromRow(row) : null;
  },

  listNodes(householdId: HouseholdId, opts: { type?: NodeType } = {}): Node[] {
    const conditions = [
      eq(nodes.householdId, householdId),
      isNull(nodes.supersededAt),
    ];
    if (opts.type) conditions.push(eq(nodes.type, opts.type));
    const rows = db
      .select()
      .from(nodes)
      .where(and(...conditions))
      .all();
    return rows.map(nodeFromRow);
  },

  createEdge(householdId: HouseholdId, candidate: EdgeCandidate): Edge {
    const id = newEdgeId();
    db.insert(edges)
      .values({
        id,
        householdId,
        type: candidate.type,
        fromNodeId: candidate.fromNodeId,
        toNodeId: candidate.toNodeId,
        attrs: candidate.attrs,
        provenanceSource: candidate.provenance.source,
        provenanceSourceRef: candidate.provenance.sourceRef ?? null,
        provenanceAssertedBy: candidate.provenance.assertedBy,
        provenanceAssertedAt: candidate.provenance.assertedAt,
        provenanceConfidence: candidate.provenance.confidence,
        provenanceStatus: candidate.provenance.status,
        createdAt: nowIso(),
      })
      .run();
    const row = db.select().from(edges).where(eq(edges.id, id)).get();
    if (!row) throw new Error("edge insert did not return");
    return edgeFromRow(row);
  },

  listEdges(
    householdId: HouseholdId,
    opts: { type?: EdgeType; fromNodeId?: NodeId; toNodeId?: NodeId } = {},
  ): Edge[] {
    const conditions = [
      eq(edges.householdId, householdId),
      isNull(edges.supersededAt),
    ];
    if (opts.type) conditions.push(eq(edges.type, opts.type));
    if (opts.fromNodeId) conditions.push(eq(edges.fromNodeId, opts.fromNodeId));
    if (opts.toNodeId) conditions.push(eq(edges.toNodeId, opts.toNodeId));
    const rows = db
      .select()
      .from(edges)
      .where(and(...conditions))
      .all();
    return rows.map(edgeFromRow);
  },

  supersedeNode(householdId: HouseholdId, id: NodeId, replacementId?: NodeId): void {
    db.update(nodes)
      .set({
        supersededAt: nowIso(),
        supersededBy: replacementId ?? null,
        provenanceStatus: "retired",
      })
      .where(and(eq(nodes.id, id), eq(nodes.householdId, householdId)))
      .run();
  },

  // Walk the supersede chain in both directions from a starting
  // node id and return every version id in the lineage, oldest
  // first. Used by the per-document audit endpoint to include
  // audit rows that were recorded against previous versions of a
  // supersede-and-replace node (e.g. an extraction.resolve event
  // lives on the pre-resolve id; the current node id would find
  // nothing without this walk).
  listNodeLineage(householdId: HouseholdId, seed: NodeId): string[] {
    const seen = new Set<string>();
    const visitBackward = (id: string): void => {
      const priors = db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(eq(nodes.householdId, householdId), eq(nodes.supersededBy, id)),
        )
        .all();
      for (const p of priors) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        visitBackward(p.id);
      }
    };
    const visitForward = (id: string): void => {
      const row = db
        .select({ supersededBy: nodes.supersededBy })
        .from(nodes)
        .where(and(eq(nodes.householdId, householdId), eq(nodes.id, id)))
        .get();
      if (row?.supersededBy && !seen.has(row.supersededBy)) {
        seen.add(row.supersededBy);
        visitForward(row.supersededBy);
      }
    };
    seen.add(seed);
    visitForward(seed);
    visitBackward(seed);
    // Order by creation time so callers see the version sequence.
    if (seen.size === 0) return [];
    const rows = db
      .select({ id: nodes.id, createdAt: nodes.createdAt })
      .from(nodes)
      .where(eq(nodes.householdId, householdId))
      .all();
    return rows
      .filter((r) => seen.has(r.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => r.id);
  },
});
