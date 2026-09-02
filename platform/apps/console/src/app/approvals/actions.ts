"use server";

import { revalidatePath } from "next/cache";
import { getSessionToken } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import type { HouseholdId } from "@atelier/domain";

export async function approveAction(
  householdId: HouseholdId,
  approvalId: string,
  note: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  try {
    const res = await api(token).approveApproval(householdId, approvalId, { note });
    revalidatePath(`/households/${householdId}`);
    revalidatePath("/dashboard");
    return { message: `Approved: ${res.approval.summary}` };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}

export async function rejectAction(
  householdId: HouseholdId,
  approvalId: string,
  note: string,
): Promise<{ message: string }> {
  const token = await getSessionToken();
  if (!token) return { message: "Session expired." };
  if (!note.trim()) return { message: "Note is required to reject." };
  try {
    const res = await api(token).rejectApproval(householdId, approvalId, { note });
    revalidatePath(`/households/${householdId}`);
    revalidatePath("/dashboard");
    return { message: `Rejected: ${res.approval.summary}` };
  } catch (err) {
    if (err instanceof ApiError) return { message: `Error: ${err.message}` };
    return { message: `Error: ${(err as Error).message}` };
  }
}
