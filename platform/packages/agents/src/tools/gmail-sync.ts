import { readGoogleAuth, type GoogleOAuthFields } from "./_google.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential } from "../types.js";

// Gmail inbound sync — pulls unread INBOX messages for a household
// that has connected a `gmail` credential, decodes their body text,
// and hands each one to an injected upsertMessage callback for
// dedupe-by-external-id insert into inbox_messages.
//
// Not a Tool in the agent sense — this is a background sync the
// runtime calls on a schedule or on-demand. It reuses the shared
// Google OAuth helper so token refresh + persistence work the same
// way as the send path.

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const LIST_QUERY = "is:unread label:INBOX";

// Adapter surface — kept narrow so tests skip the DB entirely.
export interface GmailSyncSink {
  upsertMessage(input: {
    householdId: HouseholdId;
    externalProvider: "gmail";
    externalMessageId: string;
    externalThreadId?: string;
    fromName: string;
    fromAddress: string;
    subject: string;
    body: string;
    receivedAt: string;
  }): { inserted: boolean };
}

// Same auth-reader surface we hand tools, minus the tool-specific
// fields. Fits the SyncContext narrowly rather than pretending to
// be a full ToolContext.
export interface GmailSyncContext {
  readonly householdId: HouseholdId;
  readonly readCredential: (provider: string) => StoredCredential | null;
  readonly persistAccessToken?: (
    credentialId: string,
    accessToken: string,
    expiresAt: string,
  ) => void;
  readonly logger?: { info: (msg: string, ctx?: unknown) => void };
}

export interface GmailSyncResult {
  readonly consulted: boolean;
  readonly listed: number;
  readonly fetched: number;
  readonly inserted: number;
  readonly skippedDuplicates: number;
  readonly error?: string;
}

const b64UrlToUtf8 = (data: string): string => {
  const normalized =
    data.replace(/-/g, "+").replace(/_/g, "/") +
    "==".slice(0, (4 - (data.length % 4)) % 4);
  try {
    return Buffer.from(normalized, "base64").toString("utf-8");
  } catch {
    return "";
  }
};

// Gmail returns payload.parts as a nested tree of MIME parts. Walk it
// for the first text/plain leaf; if there isn't one, fall back to
// text/html with tags stripped.
interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

const extractBody = (payload: GmailPart | undefined): string => {
  if (!payload) return "";
  const flat: GmailPart[] = [];
  const walk = (p: GmailPart): void => {
    flat.push(p);
    if (Array.isArray(p.parts)) for (const c of p.parts) walk(c);
  };
  walk(payload);

  const text = flat.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (text?.body?.data) return b64UrlToUtf8(text.body.data).trim();

  const html = flat.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html?.body?.data) {
    const raw = b64UrlToUtf8(html.body.data);
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const anyBody = flat.find((p) => p.body?.data);
  return anyBody?.body?.data ? b64UrlToUtf8(anyBody.body.data).trim() : "";
};

// Parse an RFC-2822 "From" header into name + address. Handles
// "Name <addr>" and "addr" forms.
const parseFrom = (raw: string): { fromName: string; fromAddress: string } => {
  const m = /^(.*?)<([^>]+)>\s*$/.exec(raw.trim());
  if (m) {
    return {
      fromName: (m[1] ?? "").trim().replace(/^"|"$/g, "") || m[2]!,
      fromAddress: m[2]!.trim(),
    };
  }
  return { fromName: raw.trim(), fromAddress: raw.trim() };
};

const headerValue = (
  headers: Array<{ name?: string; value?: string }>,
  name: string,
): string => {
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
};

export const syncGmailInbox = async (
  ctx: GmailSyncContext,
  sink: GmailSyncSink,
  opts: { maxResults?: number } = {},
): Promise<GmailSyncResult> => {
  const auth = await readGoogleAuth<GoogleOAuthFields>(
    { ...ctx, authorityId: undefined, proposedBy: { actor: "gmail_sync", version: "0.1.0" } },
    "gmail",
  );
  if (!auth) {
    return {
      consulted: false,
      listed: 0,
      fetched: 0,
      inserted: 0,
      skippedDuplicates: 0,
    };
  }

  const maxResults = Math.min(Math.max(opts.maxResults ?? 25, 1), 100);
  const listUrl = `${GMAIL_BASE}/users/me/messages?q=${encodeURIComponent(LIST_QUERY)}&maxResults=${maxResults}`;
  let listJson: {
    messages?: Array<{ id?: string; threadId?: string }>;
  };
  try {
    const listRes = await fetch(listUrl, {
      headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    if (!listRes.ok) {
      const text = await listRes.text().catch(() => listRes.statusText);
      return {
        consulted: true,
        listed: 0,
        fetched: 0,
        inserted: 0,
        skippedDuplicates: 0,
        error: `gmail_list_${listRes.status}: ${text.slice(0, 200)}`,
      };
    }
    listJson = (await listRes.json()) as typeof listJson;
  } catch (err) {
    return {
      consulted: true,
      listed: 0,
      fetched: 0,
      inserted: 0,
      skippedDuplicates: 0,
      error: `gmail_list_fetch: ${(err as Error).message}`,
    };
  }

  const ids = (listJson.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));

  let inserted = 0;
  let fetched = 0;
  let skippedDuplicates = 0;

  for (const id of ids) {
    const url = `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(id)}?format=full`;
    let msg: {
      id?: string;
      threadId?: string;
      internalDate?: string;
      payload?: {
        headers?: Array<{ name?: string; value?: string }>;
      } & GmailPart;
    };
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${auth.accessToken}` },
      });
      if (!res.ok) {
        ctx.logger?.info("gmail message fetch failed", {
          id,
          status: res.status,
        });
        continue;
      }
      msg = (await res.json()) as typeof msg;
      fetched++;
    } catch (err) {
      ctx.logger?.info("gmail message fetch threw", {
        id,
        error: (err as Error).message,
      });
      continue;
    }

    const headers = msg.payload?.headers ?? [];
    const fromRaw = headerValue(headers, "From");
    const subject = headerValue(headers, "Subject") || "(no subject)";
    const dateHeader = headerValue(headers, "Date");
    const { fromName, fromAddress } = parseFrom(fromRaw);
    const body = extractBody(msg.payload);
    const receivedAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : dateHeader
        ? new Date(dateHeader).toISOString()
        : new Date().toISOString();

    const { inserted: didInsert } = sink.upsertMessage({
      householdId: ctx.householdId,
      externalProvider: "gmail",
      externalMessageId: id,
      ...(msg.threadId ? { externalThreadId: msg.threadId } : {}),
      fromName,
      fromAddress,
      subject,
      body,
      receivedAt,
    });
    if (didInsert) inserted++;
    else skippedDuplicates++;
  }

  ctx.logger?.info("gmail sync completed", {
    listed: ids.length,
    fetched,
    inserted,
    skippedDuplicates,
  });

  return {
    consulted: true,
    listed: ids.length,
    fetched,
    inserted,
    skippedDuplicates,
  };
};
