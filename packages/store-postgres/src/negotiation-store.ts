import type postgres from "postgres";
import type { NegotiationNode, NegotiationStore } from "@x490/agents";
import { computeNodeHash } from "@x490/agents";

type Sql = ReturnType<typeof postgres>;

interface NegotiationRow {
  id: string;
  session_id: string;
  contract_id: string | null;
  role: string;
  round: number;
  requirements: unknown;
  proposed_terms: unknown;
  decision: string;
  reason: string;
  parent_hash: string | null;
  hash: string;
  created_at: Date;
}

function rowToNode(r: NegotiationRow): NegotiationNode {
  return {
    id: r.id,
    sessionId: r.session_id,
    ...(r.contract_id !== null ? { contractId: r.contract_id } : {}),
    role: r.role as NegotiationNode["role"],
    round: r.round,
    requirements: r.requirements as Record<string, unknown>,
    ...(r.proposed_terms !== null ? { proposedTerms: r.proposed_terms as Record<string, unknown> } : {}),
    decision: r.decision,
    reason: r.reason,
    ...(r.parent_hash !== null ? { parentHash: r.parent_hash } : {}),
    hash: r.hash,
    createdAt: r.created_at,
  };
}

/**
 * Postgres-backed Merkle DAG for negotiation history.
 *
 * Each session's nodes form a tamper-evident chain via `parent_hash`.
 * The parent hash is the hash of the previous node in the same session,
 * resolved by querying the latest node at insert time.
 */
export class PostgresNegotiationStore implements NegotiationStore {
  constructor(private readonly sql: Sql) {}

  async append(
    partial: Omit<NegotiationNode, "id" | "hash" | "createdAt" | "parentHash">,
  ): Promise<NegotiationNode> {
    return await this.sql.begin(async (tx) => {
      // Fetch previous tip for this session (FOR UPDATE to serialise concurrent rounds)
      const tipRows = await tx<{ hash: string }[]>`
        SELECT hash FROM negotiation_nodes
        WHERE session_id = ${partial.sessionId}
        ORDER BY round DESC, created_at DESC
        LIMIT 1
        FOR UPDATE
      `;
      const parentHash = tipRows[0]?.hash;

      const withParent: Omit<NegotiationNode, "id" | "hash" | "createdAt"> = {
        ...partial,
        ...(parentHash !== undefined ? { parentHash } : {}),
      };
      const hash = await computeNodeHash(withParent);

      const id = crypto.randomUUID();
      const createdAt = new Date();

      await tx`
        INSERT INTO negotiation_nodes
          (id, session_id, contract_id, role, round, requirements, proposed_terms,
           decision, reason, parent_hash, hash, created_at)
        VALUES (
          ${id},
          ${partial.sessionId},
          ${partial.contractId ?? null},
          ${partial.role},
          ${partial.round},
          ${tx.json(partial.requirements as never)},
          ${partial.proposedTerms ? tx.json(partial.proposedTerms as never) : null},
          ${partial.decision},
          ${partial.reason},
          ${parentHash ?? null},
          ${hash},
          ${createdAt}
        )
      `;

      return {
        ...withParent,
        id,
        hash,
        createdAt,
      };
    });
  }

  async getHistory(sessionId: string): Promise<NegotiationNode[]> {
    const rows = await this.sql<NegotiationRow[]>`
      SELECT id, session_id, contract_id, role, round, requirements, proposed_terms,
             decision, reason, parent_hash, hash, created_at
      FROM negotiation_nodes
      WHERE session_id = ${sessionId}
      ORDER BY round ASC, created_at ASC
    `;
    return rows.map(rowToNode);
  }
}
