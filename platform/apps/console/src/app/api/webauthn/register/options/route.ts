import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/session";

const API_URL = process.env.ATELIER_API_URL ?? "http://localhost:3001";

export async function POST(req: Request): Promise<Response> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  const body = await req.text();
  const res = await fetch(`${API_URL}/webauthn/register/options`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body,
    cache: "no-store",
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
