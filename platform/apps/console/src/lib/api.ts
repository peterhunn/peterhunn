import type { Actor, HouseholdId } from "@atelier/domain";

// Server-side API client. Every call carries the manager's bearer token
// from the httpOnly session cookie — the browser never sees it.

const API_URL = process.env.ATELIER_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const request = async <T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      // ignore body parse failure
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
};

export interface Household {
  readonly id: HouseholdId;
  readonly name: string;
  readonly tier: "life" | "executive" | "private";
  readonly riskTier: "standard" | "elevated" | "hnw";
  readonly createdAt: string;
}

export interface NodeSummary {
  readonly id: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly provenance: {
    readonly source: string;
    readonly assertedBy: string;
    readonly assertedAt: string;
    readonly confidence: number;
    readonly status: "candidate" | "confirmed" | "retired";
  };
  readonly createdAt: string;
}

export interface AuditEventSummary {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly sensitive: "yes" | "no";
  readonly at: string;
}

export const api = (token: string) => ({
  me: () => request<{ actor: Actor }>(token, "GET", "/me"),
  listHouseholds: () => request<{ households: Household[] }>(token, "GET", "/households"),
  getHousehold: (id: HouseholdId) =>
    request<{ household: Household }>(token, "GET", `/households/${id}`),
  listNodes: (id: HouseholdId) =>
    request<{ nodes: NodeSummary[] }>(token, "GET", `/households/${id}/nodes`),
  listAudit: (id: HouseholdId) =>
    request<{ events: AuditEventSummary[] }>(token, "GET", `/households/${id}/audit`),
});
