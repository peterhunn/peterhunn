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
    ...(body !== undefined && { body: JSON.stringify(body) }),
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

export interface PasskeySummary {
  readonly id: string;
  readonly deviceLabel: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export const api = (token: string) => ({
  me: () => request<{ actor: Actor }>(token, "GET", "/me"),
  listPasskeys: () =>
    request<{ passkeys: PasskeySummary[] }>(token, "GET", "/me/passkeys"),
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
  modelCallsDaily: (id: HouseholdId, windowDays = 30) =>
    request<{
      windowDays: number;
      days: Array<{
        day: string;
        totalUsd: number;
        totalCalls: number;
        byTier: Record<string, { usd: number; calls: number }>;
      }>;
    }>(
      token,
      "GET",
      `/households/${id}/model-calls/daily?windowDays=${windowDays}`,
    ),
  taskModelCalls: (id: HouseholdId, taskId: string) =>
    request<{
      task: {
        id: string;
        agent: string;
        kind: string;
        state: string;
        decisionSummary: string | null;
        createdAt: string;
      };
      summary: {
        totalCalls: number;
        totalUsd: number;
        totalTokensIn: number;
        totalTokensOut: number;
        totalCachedInputTokens: number;
      };
      calls: Array<{
        id: string;
        createdAt: string;
        taskClass: string;
        minTier: string;
        selectedTier: string;
        modelId: string;
        provider: string;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        cacheWriteInputTokens: number;
        costUsdEstimated: number;
        latencyMs: number;
        finishReason: string;
        routerReasons: string[];
        summary: string;
      }>;
    }>(token, "GET", `/households/${id}/tasks/${taskId}/model-calls`),
  runDetail: (id: HouseholdId, runId: string) =>
    request<{
      run: {
        id: string;
        intentKind: string;
        intentAttrs: Record<string, unknown>;
        origin: string;
        originBy: string;
        state: string;
        createdAt: string;
        finishedAt: string | null;
      };
      summary: {
        taskCount: number;
        modelCallCount: number;
        actionCount: number;
        totalUsd: number;
      };
      timeline: Array<{
        at: string;
        kind: "run" | "task" | "model_call" | "action";
        summary: string;
        detail?: Record<string, unknown>;
      }>;
    }>(token, "GET", `/households/${id}/runs/${runId}`),
  inferenceBudget: (id: HouseholdId) =>
    request<{
      totalUsd: number;
      totalCalls: number;
      capUsd: number;
      status: "under" | "approaching" | "over" | "over_hard";
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
  listMessagingEndpoints: (id: HouseholdId) =>
    request<{
      endpoints: Array<{
        id: string;
        channel: "sms" | "whatsapp" | "imessage" | "email";
        address: string;
        label: string | null;
        principalId: string | null;
        createdAt: string;
        revokedAt: string | null;
        consentStatus: "unknown" | "opted_in" | "opted_out";
        consentRecordedAt: string | null;
        consentSource: string | null;
      }>;
    }>(token, "GET", `/households/${id}/messaging/endpoints`),
  addMessagingEndpoint: (
    id: HouseholdId,
    input: {
      channel: "sms" | "whatsapp" | "imessage" | "email";
      address: string;
      label?: string;
      principalId?: string;
    },
  ) =>
    request<{ endpoint: { id: string } }>(
      token,
      "POST",
      `/households/${id}/messaging/endpoints`,
      input,
    ),
  revokeMessagingEndpoint: (id: HouseholdId, endpointId: string) =>
    request<void>(
      token,
      "DELETE",
      `/households/${id}/messaging/endpoints/${endpointId}`,
    ),
  listPeople: (id: HouseholdId) =>
    request<{
      people: {
        principal: Array<{ id: string; data: Record<string, unknown> }>;
        member: Array<{ id: string; data: Record<string, unknown> }>;
        staff: Array<{ id: string; data: Record<string, unknown> }>;
        contact: Array<{ id: string; data: Record<string, unknown> }>;
      };
    }>(token, "GET", `/households/${id}/people`),
  createPerson: (
    id: HouseholdId,
    input: {
      kind: "principal" | "member" | "staff" | "contact";
      data: Record<string, unknown>;
    },
  ) =>
    request<{
      person: { id: string; kind: string; data: Record<string, unknown> };
    }>(token, "POST", `/households/${id}/people`, input),
  updatePerson: (
    id: HouseholdId,
    nodeId: string,
    data: Record<string, unknown>,
  ) =>
    request<{
      person: { id: string; kind: string; data: Record<string, unknown> };
    }>(token, "PATCH", `/households/${id}/people/${nodeId}`, { data }),
  deletePerson: (id: HouseholdId, nodeId: string) =>
    request<void>(token, "DELETE", `/households/${id}/people/${nodeId}`),
  listDocuments: (id: HouseholdId) =>
    request<{
      documents: {
        identity: Array<{ id: string; data: Record<string, unknown> }>;
        legal: Array<{ id: string; data: Record<string, unknown> }>;
        policy: Array<{ id: string; data: Record<string, unknown> }>;
        record: Array<{ id: string; data: Record<string, unknown> }>;
        receipt: Array<{ id: string; data: Record<string, unknown> }>;
      };
    }>(token, "GET", `/households/${id}/documents`),
  createDocument: (
    id: HouseholdId,
    input: {
      subcategory: "identity" | "legal" | "policy" | "record" | "receipt";
      data: Record<string, unknown>;
    },
  ) =>
    request<{
      document: {
        id: string;
        subcategory: string;
        data: Record<string, unknown>;
      };
    }>(token, "POST", `/households/${id}/documents`, input),
  updateDocument: (
    id: HouseholdId,
    nodeId: string,
    data: Record<string, unknown>,
  ) =>
    request<{
      document: {
        id: string;
        subcategory: string;
        data: Record<string, unknown>;
      };
    }>(token, "PATCH", `/households/${id}/documents/${nodeId}`, { data }),
  deleteDocument: (id: HouseholdId, nodeId: string) =>
    request<void>(token, "DELETE", `/households/${id}/documents/${nodeId}`),
  listAssets: (id: HouseholdId) =>
    request<{
      assets: {
        property: Array<{ id: string; data: Record<string, unknown> }>;
        vehicle: Array<{ id: string; data: Record<string, unknown> }>;
        equipment: Array<{ id: string; data: Record<string, unknown> }>;
        membership: Array<{ id: string; data: Record<string, unknown> }>;
        pet: Array<{ id: string; data: Record<string, unknown> }>;
      };
    }>(token, "GET", `/households/${id}/assets`),
  createAsset: (
    id: HouseholdId,
    input: {
      kind: "property" | "vehicle" | "equipment" | "membership" | "pet";
      data: Record<string, unknown>;
    },
  ) =>
    request<{
      asset: { id: string; kind: string; data: Record<string, unknown> };
    }>(token, "POST", `/households/${id}/assets`, input),
  updateAsset: (
    id: HouseholdId,
    nodeId: string,
    data: Record<string, unknown>,
  ) =>
    request<{
      asset: { id: string; kind: string; data: Record<string, unknown> };
    }>(token, "PATCH", `/households/${id}/assets/${nodeId}`, { data }),
  deleteAsset: (id: HouseholdId, nodeId: string) =>
    request<void>(token, "DELETE", `/households/${id}/assets/${nodeId}`),
  listPlaybooks: (id: HouseholdId) =>
    request<{
      playbooks: Array<{
        id: string;
        name: string;
        description: string;
        domain: string;
        schedule: Record<string, unknown>;
        defaultConfig: Record<string, unknown>;
        enabled: boolean;
        registered: boolean;
        config: Record<string, unknown>;
        lastFireAt: string | null;
        nextFireAt: string | null;
        lastRunId: string | null;
      }>;
    }>(token, "GET", `/households/${id}/playbooks`),
  enablePlaybook: (
    id: HouseholdId,
    playbookId: string,
    config?: Record<string, unknown>,
  ) =>
    request<{ playbook: Record<string, unknown> }>(
      token,
      "PUT",
      `/households/${id}/playbooks/${playbookId}`,
      config ? { config } : {},
    ),
  disablePlaybook: (id: HouseholdId, playbookId: string) =>
    request<void>(token, "DELETE", `/households/${id}/playbooks/${playbookId}`),
  runPlaybookNow: (id: HouseholdId, playbookId: string) =>
    request<{
      fire: {
        outcome: "fired" | "skipped" | "unknown_playbook" | "error";
        reason?: string;
        runId?: string;
      } | null;
    }>(token, "POST", `/households/${id}/playbooks/${playbookId}/run`),
  listVerifications: (id: HouseholdId) =>
    request<{
      verifications: Array<{
        id: string;
        channel: "sms" | "whatsapp" | "imessage" | "email";
        code: string;
        expiresAt: string;
        consumedAt: string | null;
        consumedFromAddress: string | null;
        label: string | null;
      }>;
    }>(token, "GET", `/households/${id}/messaging/verifications`),
  createVerification: (
    id: HouseholdId,
    input: {
      channel: "sms" | "whatsapp" | "imessage" | "email";
      ttlSeconds?: number;
      label?: string;
    },
  ) =>
    request<{
      verification: {
        id: string;
        channel: "sms" | "whatsapp" | "imessage" | "email";
        code: string;
        expiresAt: string;
        label: string | null;
      };
    }>(token, "POST", `/households/${id}/messaging/verifications`, input),
  inviteCustomer: (
    id: HouseholdId,
    input: {
      channel: "sms" | "whatsapp";
      address: string;
      label?: string;
      principalId?: string;
      ttlSeconds?: number;
      bodyOverride?: string;
    },
  ) =>
    request<{
      invite: {
        verificationId: string;
        code: string;
        expiresAt: string;
        senderSource: "household" | "concierge" | "none";
      };
      sent: {
        provider: "twilio" | "mock";
        externalMessageId: string;
        from: string;
        to: string;
        eventId: string;
        status?: string;
        reason?: string;
      };
    }>(token, "POST", `/households/${id}/messaging/invite`, input),
  messagingConfig: () =>
    request<{
      conciergeNumber: string | null;
      conciergeMessagingServiceSid: string | null;
      sharedLineActive: boolean;
    }>(token, "GET", "/messaging/config"),
  sendMessage: (
    id: HouseholdId,
    input: { channel: "sms" | "whatsapp"; to: string; body: string },
  ) =>
    request<{
      sent: {
        provider: "twilio" | "mock";
        externalMessageId: string;
        from: string;
        to: string;
        eventId: string;
        status?: string;
        reason?: string;
      };
    }>(token, "POST", `/households/${id}/messaging/send`, input),
  listMessagingEvents: (id: HouseholdId) =>
    request<{
      events: Array<{
        id: string;
        direction: "inbound" | "outbound";
        channel: string;
        provider: string;
        fromAddress: string;
        toAddress: string;
        body: string;
        receivedAt: string;
        plannerRunId: string | null;
        endpointId: string | null;
        sessionId: string | null;
        deliveryStatus: string | null;
        deliveryStatusAt: string | null;
        deliveryErrorCode: string | null;
      }>;
    }>(token, "GET", `/households/${id}/messaging/events`),
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
