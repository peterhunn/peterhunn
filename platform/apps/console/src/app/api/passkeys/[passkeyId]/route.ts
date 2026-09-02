import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/session";

const API_URL = process.env.ATELIER_API_URL ?? "http://localhost:3001";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ passkeyId: string }> },
): Promise<Response> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  const { passkeyId } = await ctx.params;
  const res = await fetch(`${API_URL}/me/passkeys/${passkeyId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return new NextResponse(res.status === 204 ? null : await res.text(), {
    status: res.status,
  });
}
