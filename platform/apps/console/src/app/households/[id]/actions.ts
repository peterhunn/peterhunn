"use server";

import { getSessionToken } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import type { HouseholdId } from "@atelier/domain";

async function runIntent(
  householdId: HouseholdId,
  kind: string,
  attrs: Record<string, unknown>,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired. Sign in again." };
  try {
    const res = await api(token).runIntent(householdId, {
      kind,
      subjectPrincipalId: "any_principal",
      attrs,
      origin: { source: "manager", by: "console" },
    });
    const task = res.run.tasks[0];
    if (!task) return { message: `Run ${res.run.state} but no task was recorded.` };
    return {
      message: `Run ${res.run.state} — task ${task.state}${
        task.decisionSummary ? `: ${task.decisionSummary}` : ""
      }`,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function runVendorScheduleIntent(
  householdId: HouseholdId,
  input: { serviceType: string; propertyNodeId: string },
): Promise<{ message: string }> {
  return runIntent(householdId, "household.vendor.schedule", input);
}

export async function runVendorPurchaseIntent(
  householdId: HouseholdId,
  input: { serviceType: string; itemDescription: string; amountUsd: number },
): Promise<{ message: string }> {
  return runIntent(householdId, "household.vendor.purchase", input);
}

export async function runCalendarCreateIntent(
  householdId: HouseholdId,
  input: { title: string; startAt: string; endAt: string },
): Promise<{ message: string }> {
  return runIntent(householdId, "calendar.appointment.create", input);
}

export async function runCalendarRescheduleIntent(
  householdId: HouseholdId,
  input: { appointmentNodeId: string; toStartAt: string; toEndAt: string },
): Promise<{ message: string }> {
  return runIntent(householdId, "calendar.appointment.reschedule", input);
}

export async function processInboxMessage(
  householdId: HouseholdId,
  msg: {
    messageId: string;
    fromName: string;
    fromAddress: string;
    subject: string;
    body: string;
  },
): Promise<{ message: string }> {
  return runIntent(householdId, "inbox.message.process", msg);
}

export async function runResearchIntent(
  householdId: HouseholdId,
  input: { question: string; category?: string },
): Promise<{ message: string }> {
  return runIntent(householdId, "research.query", input);
}

export async function runAdminReviewIntent(
  householdId: HouseholdId,
  input: { windowDays?: number },
): Promise<{ message: string }> {
  return runIntent(householdId, "admin.renewals.review", input);
}

export async function runFamilyCoverageIntent(
  householdId: HouseholdId,
  input: { startAt: string; endAt: string; notes?: string },
): Promise<{ message: string }> {
  return runIntent(householdId, "family.coverage.propose", input);
}

export async function runTravelTripPlanIntent(
  householdId: HouseholdId,
  input: {
    destination: string;
    startAt: string;
    endAt: string;
    notes?: string;
  },
): Promise<{ message: string }> {
  return runIntent(householdId, "travel.trip.plan", input);
}

export async function syncGmail(
  householdId: HouseholdId,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    // Pull both mailboxes in one action so the unified per-customer
    // timeline picks up both halves of a conversation. Backend
    // fires two syncs back-to-back with independent cursors.
    const res = await api(token).syncGmailInbox(householdId, {
      mailbox: "both",
    });
    if ("mailboxes" in res) {
      const parts = res.mailboxes
        .map(
          (m) =>
            `${m.mailbox}: ${m.result.inserted} new / ${m.result.skippedDuplicates} seen`,
        )
        .join(" · ");
      return { message: `Synced Gmail — ${parts}.` };
    }
    // Server ran in single-mailbox mode (shouldn't happen while we
    // ask for "both", but the union type lets us stay safe).
    const s = res.sync;
    return {
      message: `Synced Gmail — listed ${s.listed}, fetched ${s.fetched}, ${
        s.inserted
      } new, ${s.skippedDuplicates} already seen.`,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 400) return { message: "Gmail is not connected — Connect Google first." };
      return { message: `Error: ${err.message}` };
    }
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function startGoogleOAuth(
  householdId: HouseholdId,
  returnTo: string,
): Promise<{ authUrl?: string; error?: string }> {
  const token = await getSessionToken();
  if (!token) return { error: "Session expired." };
  try {
    const res = await api(token).startGoogleOAuth(householdId, { returnTo });
    return { authUrl: res.authUrl };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: (err as Error).message };
  }
}

export async function fetchTaskModelCalls(
  householdId: HouseholdId,
  taskId: string,
): Promise<
  | {
      ok: true;
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
        modelId: string;
        selectedTier: string;
        taskClass: string;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        costUsdEstimated: number;
        latencyMs: number;
        routerReasons: string[];
        summary: string;
      }>;
    }
  | { ok: false; message: string }
> {
  const token = await getSessionToken();
  if (!token) return { ok: false, message: "Session expired." };
  try {
    const res = await api(token).taskModelCalls(householdId, taskId);
    return { ok: true, summary: res.summary, calls: res.calls };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, message: err.message };
    return { ok: false, message: (err as Error).message };
  }
}

export async function fetchRunDetail(
  householdId: HouseholdId,
  runId: string,
): Promise<
  | {
      ok: true;
      run: {
        id: string;
        intentKind: string;
        state: string;
        origin: string;
        originBy: string;
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
      }>;
    }
  | { ok: false; message: string }
> {
  const token = await getSessionToken();
  if (!token) return { ok: false, message: "Session expired." };
  try {
    const res = await api(token).runDetail(householdId, runId);
    return {
      ok: true,
      run: res.run,
      summary: res.summary,
      timeline: res.timeline,
    };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, message: err.message };
    return { ok: false, message: (err as Error).message };
  }
}

export type DocumentSubcategory = "identity" | "legal" | "policy" | "record" | "receipt";

// Files are uploaded via a Route Handler proxy at
// /api/documents/[householdId]/[nodeId]/file rather than through a
// server action — server actions cap request bodies at 1MB which
// would rule out real documents. The handler reads the session
// cookie and streams to the Fastify API with the bearer.

export async function addDocument(
  householdId: HouseholdId,
  input: { subcategory: DocumentSubcategory; data: Record<string, unknown> },
): Promise<{ message: string; id?: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).createDocument(householdId, input);
    return { message: `Added ${input.subcategory} document.`, id: res.document.id };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function updateDocument(
  householdId: HouseholdId,
  nodeId: string,
  data: Record<string, unknown>,
): Promise<{ message: string; id?: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).updateDocument(householdId, nodeId, data);
    return { message: "Updated.", id: res.document.id };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function removeDocument(
  householdId: HouseholdId,
  nodeId: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    await api(token).deleteDocument(householdId, nodeId);
    return { message: "Removed." };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function resolveDocumentExtraction(
  householdId: HouseholdId,
  nodeId: string,
  body: { accept: string[]; edits?: Record<string, unknown> },
): Promise<{
  message: string;
  id?: string;
  data?: Record<string, unknown>;
  acceptedCount?: number;
}> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).resolveDocumentExtraction(
      householdId,
      nodeId,
      body,
    );
    return {
      message:
        body.accept.length === 0
          ? "Extraction dismissed."
          : `Accepted ${res.acceptedCount} field${res.acceptedCount === 1 ? "" : "s"}.`,
      id: res.document.id,
      data: res.document.data,
      acceptedCount: res.acceptedCount,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export interface CustomerActivityResponse {
  principalId: string;
  endpoints: Array<{
    id: string;
    channel: "sms" | "whatsapp" | "imessage" | "email";
    address: string;
    consentStatus: "unknown" | "opted_in" | "opted_out";
  }>;
  items: Array<{
    source: "sms" | "whatsapp" | "imessage" | "email";
    direction: "inbound" | "outbound";
    at: string;
    summary: string;
    body: string;
    from: string;
    to: string;
    endpointId: string | null;
    refId: string;
    refKind: "messaging_event" | "inbox_message";
    detail: Record<string, unknown>;
  }>;
  counts: { sms: number; whatsapp: number; imessage: number; email: number };
}

export async function loadCustomerActivity(
  householdId: HouseholdId,
  principalId: string,
): Promise<{ message: string; data?: CustomerActivityResponse }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).customerActivity(householdId, principalId);
    return {
      message: `Loaded ${res.items.length} item${res.items.length === 1 ? "" : "s"}.`,
      data: res,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export interface DocumentAuditEvent {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceId: string;
  at: string;
  metadata: {
    method?: string;
    url?: string;
    status?: number;
    route?: Record<string, unknown>;
  };
}

export async function loadDocumentAudit(
  householdId: HouseholdId,
  nodeId: string,
): Promise<{
  message: string;
  lineage?: string[];
  events?: DocumentAuditEvent[];
}> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).documentAudit(householdId, nodeId);
    return {
      message: `Loaded ${res.events.length} event${res.events.length === 1 ? "" : "s"}.`,
      lineage: res.lineage,
      events: res.events as DocumentAuditEvent[],
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export type AssetKind = "property" | "vehicle" | "equipment" | "membership" | "pet";

export async function addAsset(
  householdId: HouseholdId,
  input: { kind: AssetKind; data: Record<string, unknown> },
): Promise<{ message: string; id?: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).createAsset(householdId, input);
    return { message: `Added ${input.kind}.`, id: res.asset.id };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function updateAsset(
  householdId: HouseholdId,
  nodeId: string,
  data: Record<string, unknown>,
): Promise<{ message: string; id?: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).updateAsset(householdId, nodeId, data);
    return { message: "Updated.", id: res.asset.id };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function removeAsset(
  householdId: HouseholdId,
  nodeId: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    await api(token).deleteAsset(householdId, nodeId);
    return { message: "Removed." };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function addPerson(
  householdId: HouseholdId,
  input: {
    kind: "principal" | "member" | "staff" | "contact";
    data: Record<string, unknown>;
  },
): Promise<{ message: string; id?: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).createPerson(householdId, input);
    return {
      message: `Added ${input.kind}: ${(res.person.data as { fullName?: string }).fullName ?? "(no name)"}.`,
      id: res.person.id,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function updatePerson(
  householdId: HouseholdId,
  nodeId: string,
  data: Record<string, unknown>,
): Promise<{ message: string; id?: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).updatePerson(householdId, nodeId, data);
    return {
      message: "Updated.",
      id: res.person.id,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function removePerson(
  householdId: HouseholdId,
  nodeId: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    await api(token).deletePerson(householdId, nodeId);
    return { message: "Removed." };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function enablePlaybook(
  householdId: HouseholdId,
  playbookId: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    await api(token).enablePlaybook(householdId, playbookId);
    return { message: "Playbook enabled." };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function disablePlaybook(
  householdId: HouseholdId,
  playbookId: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    await api(token).disablePlaybook(householdId, playbookId);
    return { message: "Playbook disabled." };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function runPlaybookNow(
  householdId: HouseholdId,
  playbookId: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).runPlaybookNow(householdId, playbookId);
    const fire = res.fire;
    if (!fire) return { message: "Playbook not enabled here." };
    return {
      message:
        fire.outcome === "fired"
          ? `Fired — run ${fire.runId?.slice(0, 10) ?? "?"}. Check Recent tasks.`
          : `Skipped: ${fire.reason ?? fire.outcome}.`,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function createVerification(
  householdId: HouseholdId,
  input: {
    channel: "sms" | "whatsapp" | "imessage" | "email";
    label?: string;
  },
): Promise<{ message: string; code?: string; expiresAt?: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).createVerification(householdId, input);
    return {
      message: `Code ${res.verification.code} — customer must text it from their ${input.channel.toUpperCase()} to the concierge line before ${new Date(
        res.verification.expiresAt,
      ).toLocaleTimeString()}.`,
      code: res.verification.code,
      expiresAt: res.verification.expiresAt,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function inviteCustomer(
  householdId: HouseholdId,
  input: {
    channel: "sms" | "whatsapp";
    address: string;
    label?: string;
    principalId?: string;
  },
): Promise<{ message: string; code?: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).inviteCustomer(householdId, input);
    const p = res.sent.provider;
    const source = res.invite.senderSource;
    const suffix =
      p === "twilio"
        ? source === "concierge"
          ? "from the platform concierge line"
          : "from the household's own Twilio number"
        : `via mock — ${res.sent.reason ?? "no live credential"}`;
    return {
      message: `Invite sent ${suffix}. Code ${res.invite.code} expires ${new Date(res.invite.expiresAt).toLocaleTimeString()}. Customer replies with the code to bind their number.`,
      code: res.invite.code,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function sendMessage(
  householdId: HouseholdId,
  input: { channel: "sms" | "whatsapp"; to: string; body: string },
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).sendMessage(householdId, input);
    const p = res.sent.provider;
    return {
      message:
        p === "twilio"
          ? `Sent ${input.channel} to ${input.to} via Twilio (${res.sent.externalMessageId}).`
          : `Sent ${input.channel} to ${input.to} via mock — ${res.sent.reason ?? "no live credential"}. Add a twilio credential to send for real.`,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function addMessagingEndpoint(
  householdId: HouseholdId,
  input: {
    channel: "sms" | "whatsapp" | "imessage" | "email";
    address: string;
    label?: string;
    principalId?: string;
  },
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    await api(token).addMessagingEndpoint(householdId, input);
    return { message: `Endpoint added for ${input.channel}:${input.address}.` };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function revokeMessagingEndpoint(
  householdId: HouseholdId,
  endpointId: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    await api(token).revokeMessagingEndpoint(householdId, endpointId);
    return { message: "Endpoint revoked." };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function setAutopilot(
  householdId: HouseholdId,
  enabled: boolean,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    await api(token).setAutopilot(householdId, enabled);
    return {
      message: enabled ? "Autopilot enabled." : "Autopilot paused.",
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function planAndRun(
  householdId: HouseholdId,
  prompt: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).planAndRun(householdId, {
      prompt,
      origin: { source: "customer", by: "console" },
    });
    const { plan, plannerTaskClass, runs } = res.planAndRun;
    if (plan.intents.length === 0) {
      return { message: `${plannerTaskClass}: ${plan.reasoning || "no intents produced"}` };
    }
    const summaries = runs.map((r, idx) => {
      const state = r.tasks[0]?.state ?? r.state;
      return `${plan.intents[idx]!.kind}=${state}`;
    });
    return {
      message: `${plannerTaskClass} → ${plan.intents.length} intent${
        plan.intents.length === 1 ? "" : "s"
      }: ${summaries.join(", ")}${plan.reasoning ? ` — ${plan.reasoning}` : ""}`,
    };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}
