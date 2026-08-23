import { NextResponse } from "next/server";

// Proxies the WebAuthn "login options" call to the API. The
// browser calls this route (same origin, cookies naturally
// forwarded) and gets back { options, challengeId }; the browser
// then hands `options` to navigator.credentials.get() and posts
// the assertion + challengeId to /api/webauthn/login/verify.
const API_URL = process.env.ATELIER_API_URL ?? "http://localhost:3001";

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  const res = await fetch(`${API_URL}/webauthn/login/options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  const payload = await res.text();
  return new NextResponse(payload, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
