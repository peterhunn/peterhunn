import gmailApi, { type gmail_v1 } from "@googleapis/gmail";
import { readGoogleAuth, type GoogleOAuthFields } from "./_google.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential } from "../types.js";

// Gmail inbound sync with incremental delta via the History API.
//
// First call for a household: full pull of unread INBOX via
// gmail.users.messages.list + gmail.users.messages.get; record the
// highest historyId as the cursor.
//
// Subsequent calls: gmail.users.history.list with the stored
// startHistoryId + historyTypes:["messageAdded"] + labelId:"INBOX"
// returns only the deltas. If the SDK throws a 404 (cursor too old
// — Gmail retains history ~7 days), we clear the cursor and fall
// back to a full pull.
//
// Not a Tool in the agent sense — this is a background sync the
// runtime calls on a schedule or on-demand. Uses the same shared
// Google OAuth helper as the message.send path so token refresh +
// persistence work identically.

// Which mailbox we're pulling from. Two flavors today:
//   inbox — unread INBOX; the classic "new mail to triage" path.
//   sent — recent SENT; used to fill in the customer's outbound
//     half of the per-person timeline. Only fetching the last 100
//     by default; the sent side is context, not a work queue.
export type GmailMailbox = "inbox" | "sent";

const LIST_QUERY: Record<GmailMailbox, string> = {
  inbox: "is:unread label:INBOX",
  sent: "in:sent",
};

const INCREMENTAL_LABEL: Record<GmailMailbox, string> = {
  inbox: "INBOX",
  sent: "SENT",
};

// Cursor label per mailbox — inbox and sent each get their own
// history cursor. Keeping the on-disk key stable ("gmail" for
// inbox) means the incremental cursor from the pre-mailbox world
// still resumes correctly; the sent side gets a fresh key.
const CURSOR_PROVIDER: Record<GmailMailbox, "gmail" | "gmail_sent"> = {
  inbox: "gmail",
  sent: "gmail_sent",
};

export interface GmailSyncSink {
  upsertMessage(input: {
    householdId: HouseholdId;
    externalProvider: "gmail";
    externalMessageId: string;
    externalThreadId?: string;
    direction?: "inbound" | "outbound";
    fromName: string;
    fromAddress: string;
    toAddress?: string;
    subject: string;
    body: string;
    receivedAt: string;
  }): { inserted: boolean };
}

export interface GmailSyncCursor {
  read(
    householdId: HouseholdId,
    provider: "gmail" | "gmail_sent",
  ): { historyId?: string } | null;
  save(
    householdId: HouseholdId,
    provider: "gmail" | "gmail_sent",
    cursor: { historyId: string },
    lastResult?: unknown,
  ): void;
  clear(householdId: HouseholdId, provider: "gmail" | "gmail_sent"): void;
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

type GmailPart = gmail_v1.Schema$MessagePart;

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
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string => {
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
};

const maxHistoryId = (a: string | undefined, b: string | undefined): string | undefined => {
  if (!a) return b;
  if (!b) return a;
  try {
    return BigInt(a) > BigInt(b) ? a : b;
  } catch {
    return b;
  }
};

const gmailErrCode = (err: unknown): number | undefined => {
  const e = err as { code?: number | string; status?: number };
  const raw = e?.code ?? e?.status;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const fetchAndParse = async (
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<
  | {
      externalMessageId: string;
      externalThreadId: string | undefined;
      fromName: string;
      fromAddress: string;
      toAddress: string | undefined;
      subject: string;
      body: string;
      receivedAt: string;
      historyId: string | undefined;
    }
  | null
> => {
  // The SDK's return type unions in the callback-overload `void`;
  // in the awaited/promise path the shape is always a GaxiosResponse
  // whose `data` is a Schema$Message.
  let msg: gmail_v1.Schema$Message;
  try {
    const res = (await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    })) as { data: gmail_v1.Schema$Message };
    msg = res.data;
  } catch {
    return null;
  }
  const headers = msg.payload?.headers ?? [];
  const fromRaw = headerValue(headers, "From");
  const toRaw = headerValue(headers, "To");
  const subject = headerValue(headers, "Subject") || "(no subject)";
  const dateHeader = headerValue(headers, "Date");
  const { fromName, fromAddress } = parseFrom(fromRaw);
  // Multi-recipient To headers keep the first address only —
  // enough to route into a customer's per-person timeline.
  // Cc / Bcc live on the raw message if a downstream needs them.
  const firstTo = toRaw ? parseFrom(toRaw.split(",")[0] ?? "").fromAddress : "";
  const body = extractBody(msg.payload ?? undefined);
  const receivedAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : dateHeader
      ? new Date(dateHeader).toISOString()
      : new Date().toISOString();
  return {
    externalMessageId: id,
    externalThreadId: msg.threadId ?? undefined,
    fromName,
    fromAddress,
    toAddress: firstTo || undefined,
    subject,
    body,
    receivedAt,
    historyId: msg.historyId ?? undefined,
  };
};

export const syncGmailInbox = async (
  ctx: GmailSyncContext,
  sink: GmailSyncSink,
  opts: {
    maxResults?: number;
    cursorStore?: GmailSyncCursor;
    mailbox?: GmailMailbox;
  } = {},
): Promise<GmailSyncResult> => {
  const mailbox: GmailMailbox = opts.mailbox ?? "inbox";
  const listQuery = LIST_QUERY[mailbox];
  const incrementalLabel = INCREMENTAL_LABEL[mailbox];
  const cursorProvider = CURSOR_PROVIDER[mailbox];
  // Sent-mail messages are inserted as outbound so the console can
  // interleave them alongside inbound in the customer timeline.
  const direction: "inbound" | "outbound" =
    mailbox === "sent" ? "outbound" : "inbound";
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

  const gmail = gmailApi.gmail({ version: "v1", auth: auth.client });
  const cursorStore = opts.cursorStore;
  const existingCursor = cursorStore?.read(ctx.householdId, cursorProvider) ?? null;

  // ── Incremental path: history API ────────────────────────────
  if (cursorStore && existingCursor?.historyId) {
    try {
      const historyRes = await gmail.users.history.list({
        userId: "me",
        startHistoryId: existingCursor.historyId,
        historyTypes: ["messageAdded"],
        labelId: incrementalLabel,
      });
      const json = historyRes.data;
      const addedIds = new Set<string>();
      for (const h of json.history ?? []) {
        for (const ma of h.messagesAdded ?? []) {
          const id = ma.message?.id;
          const labels = ma.message?.labelIds ?? [];
          if (id && labels.includes(incrementalLabel)) addedIds.add(id);
        }
      }
      if (addedIds.size === 0) {
        cursorStore.save(
          ctx.householdId,
          cursorProvider,
          { historyId: json.historyId ?? existingCursor.historyId },
          { at: new Date().toISOString(), mode: "up_to_date", mailbox },
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
        const parsed = await fetchAndParse(gmail, id);
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
          direction,
          fromName: parsed.fromName,
          fromAddress: parsed.fromAddress,
          ...(parsed.toAddress ? { toAddress: parsed.toAddress } : {}),
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
          cursorProvider,
          { historyId: newHistoryId },
          { at: new Date().toISOString(), mode: "incremental", inserted, mailbox },
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
    } catch (err) {
      const status = gmailErrCode(err);
      if (status === 404) {
        // Cursor too old — wipe and fall through to the full path.
        cursorStore.clear(ctx.householdId, cursorProvider);
        ctx.logger?.info("gmail history cursor expired; resetting to full sync", {
          oldHistoryId: existingCursor.historyId,
          mailbox,
        });
      } else {
        return {
          consulted: true,
          mode: "incremental",
          listed: 0,
          fetched: 0,
          inserted: 0,
          skippedDuplicates: 0,
          error: `gmail_history_${status ?? "err"}: ${(err as Error).message.slice(0, 200)}`,
        };
      }
    }
  }

  // ── Full pull ────────────────────────────────────────────────
  const maxResults = Math.min(Math.max(opts.maxResults ?? 25, 1), 100);
  let listJson: gmail_v1.Schema$ListMessagesResponse;
  try {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: listQuery,
      maxResults,
    });
    listJson = listRes.data;
  } catch (err) {
    return {
      consulted: true,
      mode: existingCursor ? "cursor_reset" : "full",
      listed: 0,
      fetched: 0,
      inserted: 0,
      skippedDuplicates: 0,
      error: `gmail_list_${gmailErrCode(err) ?? "err"}: ${(err as Error).message.slice(0, 200)}`,
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
    const parsed = await fetchAndParse(gmail, id);
    if (!parsed) continue;
    fetched++;
    newHistoryId = maxHistoryId(newHistoryId, parsed.historyId);
    const { inserted: didInsert } = sink.upsertMessage({
      householdId: ctx.householdId,
      externalProvider: "gmail",
      externalMessageId: parsed.externalMessageId,
      ...(parsed.externalThreadId ? { externalThreadId: parsed.externalThreadId } : {}),
      direction,
      fromName: parsed.fromName,
      fromAddress: parsed.fromAddress,
      ...(parsed.toAddress ? { toAddress: parsed.toAddress } : {}),
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
      cursorProvider,
      { historyId: newHistoryId },
      {
        at: new Date().toISOString(),
        mode: existingCursor ? "cursor_reset" : "full",
        inserted,
        mailbox,
      },
    );
  }

  ctx.logger?.info("gmail sync completed", {
    mailbox,
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
