"use server";

import { redirect } from "next/navigation";
import { setSessionToken, clearSessionToken } from "@/lib/session";
import { api, ApiError } from "@/lib/api";

export async function login(formData: FormData): Promise<{ error?: string } | void> {
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return { error: "Token is required." };

  try {
    await api(token).me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { error: "That token isn't recognized." };
    }
    return { error: "Could not verify the token. Is the API running?" };
  }

  await setSessionToken(token);
  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  await clearSessionToken();
  redirect("/");
}
