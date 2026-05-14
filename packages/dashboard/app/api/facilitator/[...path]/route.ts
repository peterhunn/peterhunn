import { getSession } from "@auth0/nextjs-auth0";
import { NextRequest, NextResponse } from "next/server";

const FACILITATOR_URL = process.env["FACILITATOR_URL"] ?? "http://localhost:4901";

type Context = { params: { path: string[] } };

async function proxy(req: NextRequest, ctx: Context): Promise<NextResponse> {
  const session = await getSession();
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = ctx.params.path.join("/");
  const upstream = new URL(`/${path}`, FACILITATOR_URL);
  req.nextUrl.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

  const body =
    req.method !== "GET" && req.method !== "DELETE" ? await req.text() : undefined;

  const res = await fetch(upstream.toString(), {
    method: req.method,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body,
  });

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
export const PUT = proxy;
export const PATCH = proxy;
