/**
 * Negotiation DAG — tracks the full round-by-round history of a contract
 * negotiation as a Merkle-linked chain of nodes.
 *
 * Each node records one LLM decision (client or server side), the requirements
 * in effect at that point, what was proposed, and what was decided. The
 * `parentHash` creates a tamper-evident chain: any edit to a prior node changes
 * its hash and breaks all descendant references.
 *
 * The interface is storage-agnostic — use InMemoryNegotiationStore for tests
 * or short-lived agents, PostgresNegotiationStore for persistent audit trails.
 */

export interface NegotiationNode {
  id: string;
  /** Stable identifier for this negotiation session (auto-UUID on client, deterministic on server). */
  sessionId: string;
  /** Set once a contract is issued at the end of the session. */
  contractId?: string;
  role: "client" | "server";
  round: number;
  requirements: Record<string, unknown>;
  proposedTerms?: Record<string, unknown>;
  /** LLM decision: accept / reject / negotiate (client) or counter_offer (server). */
  decision: string;
  reason: string;
  /** SHA-256 hash of the previous node in this session, undefined for the first node. */
  parentHash?: string;
  /** SHA-256 hash of this node's canonical representation. */
  hash: string;
  createdAt: Date;
}

export interface NegotiationStore {
  /**
   * Append a new node to the DAG. The store resolves the parentHash from
   * the previous tip for `sessionId` automatically.
   */
  append(
    partial: Omit<NegotiationNode, "id" | "hash" | "createdAt" | "parentHash">,
  ): Promise<NegotiationNode>;
  /** Return all nodes for a session, oldest first. */
  getHistory(sessionId: string): Promise<NegotiationNode[]>;
}

// ── Hash helper ────────────────────────────────────────────────────────────────

export async function computeNodeHash(
  partial: Omit<NegotiationNode, "id" | "hash" | "createdAt">,
): Promise<string> {
  const canonical = JSON.stringify({
    sessionId: partial.sessionId,
    role: partial.role,
    round: partial.round,
    requirements: partial.requirements,
    proposedTerms: partial.proposedTerms ?? null,
    decision: partial.decision,
    reason: partial.reason,
    parentHash: partial.parentHash ?? null,
  });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── In-memory implementation (tests / ephemeral agents) ───────────────────────

export class InMemoryNegotiationStore implements NegotiationStore {
  private readonly nodes: NegotiationNode[] = [];

  async append(
    partial: Omit<NegotiationNode, "id" | "hash" | "createdAt" | "parentHash">,
  ): Promise<NegotiationNode> {
    const sessionNodes = this.nodes.filter((n) => n.sessionId === partial.sessionId);
    const parentHash = sessionNodes.at(-1)?.hash;
    const withParent: Omit<NegotiationNode, "id" | "hash" | "createdAt"> = {
      ...partial,
      ...(parentHash !== undefined ? { parentHash } : {}),
    };
    const hash = await computeNodeHash(withParent);
    const node: NegotiationNode = {
      ...withParent,
      id: crypto.randomUUID(),
      hash,
      createdAt: new Date(),
    };
    this.nodes.push(node);
    return node;
  }

  async getHistory(sessionId: string): Promise<NegotiationNode[]> {
    return this.nodes.filter((n) => n.sessionId === sessionId);
  }
}

// ── History formatting for LLM context ────────────────────────────────────────

export function formatNegotiationHistory(history: NegotiationNode[]): string {
  if (history.length === 0) return "";
  const lines = history.map((n) => {
    const proposed = n.proposedTerms ? ` → proposed ${JSON.stringify(n.proposedTerms)}` : "";
    return `Round ${n.round} [${n.role}/${n.decision}]: ${n.reason}${proposed}`;
  });
  return `NEGOTIATION HISTORY (${history.length} prior round${history.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}
