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
    const res = await api(token).syncGmailInbox(householdId);
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
