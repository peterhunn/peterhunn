import { readGoogleAuth, type GoogleOAuthFields } from "./_google.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential } from "../types.js";

// Gmail inbound sync with incremental delta via the History API.
//
// First call for a household: full pull of unread INBOX, then we
// record the highest historyId seen as the cursor.
//
// Subsequent calls: users/me/history?startHistoryId=<cursor>&
// historyTypes=messageAdded returns only the deltas. If Gmail
// returns 404 (cursor too old — history retained ~7 days), we
// clear the cursor and fall back to a full pull.
//
// Not a Tool in the agent sense — this is a background sync the
// runtime calls on a schedule or on-demand. Reuses the shared
// Google OAuth helper so token refresh + persistence work the same
// way as the send path.

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const LIST_QUERY = "is:unread label:INBOX";

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

export interface GmailSyncCursor {
  read(householdId: HouseholdId, provider: "gmail"): { historyId?: string } | null;
  save(
    householdId: HouseholdId,
    provider: "gmail",
    cursor: { historyId: string },
    lastResult?: unknown,
  ): void;
  clear(householdId: HouseholdId, provider: "gmail"): void;
}

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
  readonly mode: "full" | "incremental" | "up_to_date" | "cursor_reset" | "none";
  readonly listed: number;
  readonly fetched: number;
  readonly inserted: number;
  readonly skippedDuplicates: number;
  readonly historyId?: string;
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

const maxHistoryId = (a: string | undefined, b: string | undefined): string | undefined => {
  if (!a) return b;
  if (!b) return a;
  // History ids are ints as strings — compare as BigInt for correctness.
  try {
    return BigInt(a) > BigInt(b) ? a : b;
  } catch {
    return b;
  }
};

// Fetch + parse one message; return an object suitable for the sink,
// plus the message's historyId so callers can advance the cursor.
const fetchAndParse = async (
  auth: { accessToken: string },
  id: string,
): Promise<
  | {
      externalMessageId: string;
      externalThreadId: string | undefined;
      fromName: string;
      fromAddress: string;
      subject: string;
      body: string;
      receivedAt: string;
      historyId: string | undefined;
    }
  | null
> => {
  const url = `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(id)}?format=full`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) return null;
  const msg = (await res.json()) as {
    id?: string;
    threadId?: string;
    historyId?: string;
    internalDate?: string;
    payload?: {
      headers?: Array<{ name?: string; value?: string }>;
    } & GmailPart;
  };
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
  return {
    externalMessageId: id,
    externalThreadId: msg.threadId,
    fromName,
    fromAddress,
    subject,
    body,
    receivedAt,
    historyId: msg.historyId,
  };
};

export const syncGmailInbox = async (
  ctx: GmailSyncContext,
  sink: GmailSyncSink,
  opts: { maxResults?: number; cursorStore?: GmailSyncCursor } = {},
): Promise<GmailSyncResult> => {
  const auth = await readGoogleAuth<GoogleOAuthFields>(
    { ...ctx, authorityId: undefined, proposedBy: { actor: "gmail_sync", version: "0.1.0" } },
    "gmail",
  );
  if (!auth) {
    return {
      consulted: false,
      mode: "none",
      listed: 0,
      fetched: 0,
      inserted: 0,
      skippedDuplicates: 0,
    };
  }

  const cursorStore = opts.cursorStore;
  const existingCursor = cursorStore?.read(ctx.householdId, "gmail") ?? null;

  // ── Incremental path: history API ────────────────────────────
  if (cursorStore && existingCursor?.historyId) {
    const url =
      `${GMAIL_BASE}/users/me/history` +
      `?startHistoryId=${encodeURIComponent(existingCursor.historyId)}` +
      `&historyTypes=messageAdded` +
      `&labelId=INBOX`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${auth.accessToken}` },
      });
    } catch (err) {
      return {
        consulted: true,
        mode: "incremental",
        listed: 0,
        fetched: 0,
        inserted: 0,
        skippedDuplicates: 0,
        error: `gmail_history_fetch: ${(err as Error).message}`,
      };
    }
    // 404 → cursor too old, wipe and fall through to the full path.
    if (res.status === 404) {
      cursorStore.clear(ctx.householdId, "gmail");
      ctx.logger?.info("gmail history cursor expired; resetting to full sync", {
        oldHistoryId: existingCursor.historyId,
      });
    } else if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return {
        consulted: true,
        mode: "incremental",
        listed: 0,
        fetched: 0,
        inserted: 0,
        skippedDuplicates: 0,
        error: `gmail_history_${res.status}: ${text.slice(0, 200)}`,
      };
    } else {
      const json = (await res.json()) as {
        history?: Array<{
          id?: string;
          messagesAdded?: Array<{
            message?: { id?: string; threadId?: string; labelIds?: string[] };
          }>;
        }>;
        historyId?: string;
      };
      const addedIds = new Set<string>();
      for (const h of json.history ?? []) {
        for (const ma of h.messagesAdded ?? []) {
          const id = ma.message?.id;
          const labels = ma.message?.labelIds ?? [];
          if (id && labels.includes("INBOX")) addedIds.add(id);
        }
      }
      if (addedIds.size === 0) {
        cursorStore.save(
          ctx.householdId,
          "gmail",
          { historyId: json.historyId ?? existingCursor.historyId },
          { at: new Date().toISOString(), mode: "up_to_date" },
        );
        return {
          consulted: true,
          mode: "up_to_date",
          listed: 0,
          fetched: 0,
          inserted: 0,
          skippedDuplicates: 0,
          historyId: json.historyId ?? existingCursor.historyId,
        };
      }

      let fetched = 0;
      let inserted = 0;
      let skipped = 0;
      let newHistoryId: string | undefined = json.historyId ?? existingCursor.historyId;
      for (const id of addedIds) {
        const parsed = await fetchAndParse(auth, id);
        if (!parsed) continue;
        fetched++;
        newHistoryId = maxHistoryId(newHistoryId, parsed.historyId);
        const { inserted: didInsert } = sink.upsertMessage({
          householdId: ctx.householdId,
          externalProvider: "gmail",
          externalMessageId: parsed.externalMessageId,
          ...(parsed.externalThreadId
            ? { externalThreadId: parsed.externalThreadId }
            : {}),
          fromName: parsed.fromName,
          fromAddress: parsed.fromAddress,
          subject: parsed.subject,
          body: parsed.body,
          receivedAt: parsed.receivedAt,
        });
        if (didInsert) inserted++;
        else skipped++;
      }
      if (newHistoryId) {
        cursorStore.save(
          ctx.householdId,
          "gmail",
          { historyId: newHistoryId },
          { at: new Date().toISOString(), mode: "incremental", inserted },
        );
      }
      return {
        consulted: true,
        mode: "incremental",
        listed: addedIds.size,
        fetched,
        inserted,
        skippedDuplicates: skipped,
        ...(newHistoryId ? { historyId: newHistoryId } : {}),
      };
    }
  }

  // ── Full pull ────────────────────────────────────────────────
  const maxResults = Math.min(Math.max(opts.maxResults ?? 25, 1), 100);
  const listUrl =
    `${GMAIL_BASE}/users/me/messages?q=${encodeURIComponent(LIST_QUERY)}` +
    `&maxResults=${maxResults}`;
  let listJson: { messages?: Array<{ id?: string; threadId?: string }> };
  try {
    const listRes = await fetch(listUrl, {
      headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    if (!listRes.ok) {
      const text = await listRes.text().catch(() => listRes.statusText);
      return {
        consulted: true,
        mode: existingCursor ? "cursor_reset" : "full",
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
      mode: existingCursor ? "cursor_reset" : "full",
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

  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let newHistoryId: string | undefined;
  for (const id of ids) {
    const parsed = await fetchAndParse(auth, id);
    if (!parsed) continue;
    fetched++;
    newHistoryId = maxHistoryId(newHistoryId, parsed.historyId);
    const { inserted: didInsert } = sink.upsertMessage({
      householdId: ctx.householdId,
      externalProvider: "gmail",
      externalMessageId: parsed.externalMessageId,
      ...(parsed.externalThreadId ? { externalThreadId: parsed.externalThreadId } : {}),
      fromName: parsed.fromName,
      fromAddress: parsed.fromAddress,
      subject: parsed.subject,
      body: parsed.body,
      receivedAt: parsed.receivedAt,
    });
    if (didInsert) inserted++;
    else skipped++;
  }

  if (cursorStore && newHistoryId) {
    cursorStore.save(
      ctx.householdId,
      "gmail",
      { historyId: newHistoryId },
      { at: new Date().toISOString(), mode: existingCursor ? "cursor_reset" : "full", inserted },
    );
  }

  ctx.logger?.info("gmail sync completed", {
    mode: existingCursor ? "cursor_reset" : "full",
    listed: ids.length,
    fetched,
    inserted,
    skippedDuplicates: skipped,
  });

  return {
    consulted: true,
    mode: existingCursor ? "cursor_reset" : "full",
    listed: ids.length,
    fetched,
    inserted,
    skippedDuplicates: skipped,
    ...(newHistoryId ? { historyId: newHistoryId } : {}),
  };
};
