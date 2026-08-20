import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/session";

// Proxy route handler for document file uploads/downloads. The
// browser talks to /api/documents/... on the console; this handler
// reads the httpOnly session cookie and forwards to the Fastify
// API with the bearer token. Doing it this way instead of a server
// action avoids the App Router's 1MB action body cap.

const API_URL = process.env.ATELIER_API_URL ?? "http://localhost:3001";

// Next 15 App Router hands params as a Promise.
type Ctx = { params: Promise<{ householdId: string; nodeId: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "no_session" }, { status: 401 });
  const { householdId, nodeId } = await ctx.params;
  const body = await req.arrayBuffer();
  const upstream = await fetch(
    `${API_URL}/households/${householdId}/documents/${nodeId}/file`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type":
          req.headers.get("content-type") ?? "application/octet-stream",
        ...(req.headers.get("x-original-filename")
          ? { "x-original-filename": req.headers.get("x-original-filename")! }
          : {}),
      },
      body,
    },
  );
  const text = await upstream.text();
  try {
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new NextResponse(text, { status: upstream.status });
  }
}

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "no_session" }, { status: 401 });
  const { householdId, nodeId } = await ctx.params;
  const upstream = await fetch(
    `${API_URL}/households/${householdId}/documents/${nodeId}/file`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!upstream.ok) {
    return NextResponse.json(
      { error: "upstream_error", status: upstream.status },
      { status: upstream.status },
    );
  }
  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      ...(upstream.headers.get("content-disposition")
        ? { "content-disposition": upstream.headers.get("content-disposition")! }
        : {}),
    },
  });
}
