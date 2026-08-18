import type {
  Actor,
  HouseholdId,
  PolicyDecision,
  PolicySpec,
} from "@atelier/domain";

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
      // ignore
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

export interface Household {
  readonly id: HouseholdId;
  readonly name: string;
  readonly tier: "life" | "executive" | "private";
  readonly riskTier: "standard" | "elevated" | "hnw";
  readonly createdAt: string;
  readonly frozenAt?: string;
  readonly frozenReason?: string;
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

export interface PolicySummary {
  readonly id: string;
  readonly spec: PolicySpec;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface ActionSummary {
  readonly id: string;
  readonly actionClass: string;
  readonly domain: string;
  readonly agent: string;
  readonly outcome: string;
  readonly summary: string;
  readonly amountUsd: number | null;
  readonly policyIdAuthorizing: string | null;
  readonly createdAt: string;
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
  listPolicies: (id: HouseholdId) =>
    request<{ policies: PolicySummary[] }>(token, "GET", `/households/${id}/policies`),
  listActions: (id: HouseholdId) =>
    request<{ actions: ActionSummary[] }>(token, "GET", `/households/${id}/actions`),
  evaluate: (id: HouseholdId, request_: unknown) =>
    request<{ decision: PolicyDecision }>(
      token,
      "POST",
      `/households/${id}/policies/evaluate`,
      request_,
    ),
  freeze: (id: HouseholdId, reason: string) =>
    request<void>(token, "POST", `/households/${id}/freeze`, { reason }),
  unfreeze: (id: HouseholdId) =>
    request<void>(token, "POST", `/households/${id}/unfreeze`),
  listTasks: (id: HouseholdId) =>
    request<{ tasks: TaskSummary[] }>(token, "GET", `/households/${id}/tasks`),
  runIntent: (id: HouseholdId, intent: unknown) =>
    request<{ run: RunResult }>(token, "POST", `/households/${id}/orchestrator/run`, intent),
});

export interface TaskSummary {
  readonly id: string;
  readonly runId: string;
  readonly agent: string;
  readonly agentVersion: string;
  readonly kind: string;
  readonly state: string;
  readonly decisionSummary: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
}

export interface RunResult {
  readonly runId: string;
  readonly intentKind: string;
  readonly state: string;
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly agent: string;
    readonly kind: string;
    readonly state: string;
    readonly decisionSummary?: string;
    readonly errorMessage?: string;
  }>;
}
