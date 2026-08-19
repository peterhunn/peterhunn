import type {
  Actor,
  ApprovalItem,
  HouseholdId,
  ModelSpec,
  PolicyDecision,
  PolicySpec,
  TaskClassSpec,
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
  readonly autopilotEnabled?: boolean;
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
  planAndRun: (id: HouseholdId, body: { prompt: string; origin?: unknown }) =>
    request<{
      planAndRun: {
        plan: {
          reasoning: string;
          intents: Array<{ kind: string; attrs: Record<string, unknown> }>;
        };
        plannerTaskClass: string;
        runs: RunResult[];
      };
    }>(token, "POST", `/households/${id}/orchestrator/plan-and-run`, body),
  listApprovals: (id: HouseholdId) =>
    request<{ approvals: ApprovalItem[] }>(token, "GET", `/households/${id}/approvals`),
  approvalInbox: () =>
    request<{ approvals: ApprovalItem[] }>(token, "GET", "/approvals/inbox"),
  approveApproval: (id: HouseholdId, approvalId: string, body: { note?: string }) =>
    request<{ approval: ApprovalItem }>(
      token,
      "POST",
      `/households/${id}/approvals/${approvalId}/approve`,
      body,
    ),
  rejectApproval: (id: HouseholdId, approvalId: string, body: { note: string }) =>
    request<{ approval: ApprovalItem }>(
      token,
      "POST",
      `/households/${id}/approvals/${approvalId}/reject`,
      body,
    ),
  listModels: () => request<{ models: ModelSpec[] }>(token, "GET", "/models"),
  listTaskClasses: () =>
    request<{ taskClasses: TaskClassSpec[] }>(token, "GET", "/models/task-classes"),
  inferenceBudget: (id: HouseholdId) =>
    request<{
      totalUsd: number;
      totalCalls: number;
      capUsd: number;
      status: "under" | "approaching" | "over";
      byTier: Record<string, { calls: number; usd: number }>;
    }>(token, "GET", `/households/${id}/inference-budget`),
  listInbox: (id: HouseholdId) =>
    request<{ messages: InboxMessageSummary[] }>(token, "GET", `/households/${id}/inbox`),
  syncGmailInbox: (id: HouseholdId, maxResults?: number) =>
    request<{
      sync: {
        consulted: boolean;
        listed: number;
        fetched: number;
        inserted: number;
        skippedDuplicates: number;
      };
    }>(
      token,
      "POST",
      `/households/${id}/inbox/sync`,
      maxResults !== undefined ? { maxResults } : {},
    ),
  setAutopilot: (id: HouseholdId, enabled: boolean) =>
    request<{ household: { id: string; autopilotEnabled: boolean } }>(
      token,
      "POST",
      `/households/${id}/autopilot`,
      { enabled },
    ),
  listCredentials: (id: HouseholdId) =>
    request<{ credentials: CredentialSummary[] }>(
      token,
      "GET",
      `/households/${id}/credentials`,
    ),
  startGoogleOAuth: (id: HouseholdId, body: { returnTo?: string }) =>
    request<{ authUrl: string }>(
      token,
      "POST",
      `/households/${id}/oauth/google/start`,
      body,
    ),
  oauthConfig: () =>
    request<{
      configured: boolean;
      clientId: boolean;
      clientSecret: boolean;
      stateSecret: boolean;
      redirectUri: string;
      scopes: string[];
    }>(token, "GET", "/oauth/google/config"),
});

export interface CredentialSummary {
  readonly id: string;
  readonly provider: string;
  readonly kind: string;
  readonly label: string;
  readonly principalRef: string | null;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface InboxMessageSummary {
  readonly id: string;
  readonly fromName: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: string;
  readonly status: "received" | "triaged" | "replied" | "archived" | "spam";
  readonly urgency: string | null;
  readonly recipientClass: string | null;
  readonly requiresReply: "yes" | "no" | "unknown";
  readonly draftReply: string | null;
  readonly triagedAt: string | null;
}

export interface TaskSummary {
  readonly id: string;
  readonly runId: string;
  readonly agent: string;
  readonly agentVersion: string;
  readonly kind: string;
  readonly state: string;
  readonly decisionSummary: string | null;
  readonly errorMessage: string | null;
  readonly outputs: Record<string, unknown> | null;
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
