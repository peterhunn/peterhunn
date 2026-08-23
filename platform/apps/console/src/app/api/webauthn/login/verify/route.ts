import { NextResponse } from "next/server";
import { setSessionToken } from "@/lib/session";

const API_URL = process.env.ATELIER_API_URL ?? "http://localhost:3001";

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  const res = await fetch(`${API_URL}/webauthn/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  const payload = (await res.json()) as { token: string; expiresAt: string | null };
  // The API returns the freshly-minted bearer token in the JSON
  // body. Stash it in the httpOnly session cookie exactly like
  // the bearer-paste login does; nothing else in the console
  // needs to know how the token was obtained.
  await setSessionToken(payload.token);
  return NextResponse.json({ ok: true, expiresAt: payload.expiresAt });
}
