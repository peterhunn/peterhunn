import {
  contactEndpointRepo,
  conversationSessionRepo,
  credentialRepo,
  householdRepo,
  inboxRepo,
  messagingEventRepo,
  type Db,
  type MessagingChannel,
} from "@atelier/db";
import { sendTwilioMessage, trySendViaGmail } from "@atelier/agents";
import type { HouseholdId } from "@atelier/domain";

// Shared outbound-message orchestration for the concierge line.
// Both /messaging/send (manager-authored) and the agent-side
// sms.send tool (agent-authored) go through this so they land the
// same way in the household's history: consent gate first, then
// send, then a messaging_events row auto-attached to the open
// conversation session.
//
// Kept in the api package (not the db package) because
// sendTwilioMessage needs the Twilio SDK, which the db package
// shouldn't depend on. The tool reaches this via a ToolContext
// seam that the runtime wires in — see runtime.ts.

// Same shape as the twilio credential blob so we can hand it
// straight to sendTwilioMessage. Duplicated instead of imported
// to avoid a cycle (the shared type would come from messaging.ts,
// which imports THIS file).
interface TwilioSenderCredential {
  readonly id?: string;
  readonly credential: {
    readonly account_sid?: string;
    readonly auth_token?: string;
    readonly from_number?: string;
    readonly messaging_service_sid?: string;
  };
  readonly expiresAt?: string;
}

// Resolve a household's outbound Twilio credential: household-
// specific first (enterprise / dedicated DID), platform concierge
// fallback (shared line). Null when neither is configured — the
// caller can still send via mock. Duplicated in messaging.ts;
// kept in sync by hand.
const platformConciergeCredential = (): TwilioSenderCredential | null => {
  const account_sid = process.env["ATELIER_TWILIO_ACCOUNT_SID"];
  const auth_token = process.env["ATELIER_TWILIO_AUTH_TOKEN"];
  const from_number = process.env["ATELIER_TWILIO_FROM_NUMBER"];
  const messaging_service_sid = process.env["ATELIER_TWILIO_MESSAGING_SERVICE_SID"];
  if (!account_sid || !auth_token) return null;
  if (!from_number && !messaging_service_sid) return null;
  return {
    credential: {
      account_sid,
      auth_token,
      ...(from_number && { from_number }),
      ...(messaging_service_sid && { messaging_service_sid }),
    },
  };
};

const resolveTwilioSender = (
  db: Db,
  householdId: HouseholdId,
): TwilioSenderCredential | null => {
  const perHousehold = credentialRepo(db).getSecret(householdId, "twilio");
  const looksComplete = (raw: { credential?: unknown } | null): boolean => {
    if (!raw) return false;
    const c = (raw.credential ?? {}) as Record<string, unknown>;
    return Boolean(
      c["account_sid"] &&
        c["auth_token"] &&
        (c["messaging_service_sid"] || c["from_number"]),
    );
  };
  if (looksComplete(perHousehold)) return perHousehold as TwilioSenderCredential;
  return platformConciergeCredential();
};

export interface SendOutboundInput {
  readonly householdId: HouseholdId;
  readonly channel: MessagingChannel;
  readonly to: string;
  readonly body: string;
  readonly logger?: { info: (msg: string, ctx?: unknown) => void };
  // Who wrote this outbound. Manager sends from /messaging/send
  // fill in the manager's actor info; agent sends via the
  // sms.send tool fill in the agent's name+version. Stamped on
  // the resulting messaging_events row so the thread view can
  // render "Ada Chen sent this" vs "concierge agent drafted."
  readonly authoredBy?: {
    readonly type: "manager" | "agent" | "system";
    readonly id: string;
    readonly label?: string;
  };
}

// Public URL Twilio POSTs status updates to (queued → sent →
// delivered / undelivered / failed / read). Resolved from env
// on every send so the operator can wire it without redeploy.
// Unset = we don't pass it, Twilio doesn't send callbacks, and
// delivery status stays null on the row (Phase-0 acceptable).
const conciergeStatusCallback = (): string | undefined => {
  const v = process.env["ATELIER_TWILIO_STATUS_CALLBACK_URL"];
  return v && v.length > 0 ? v : undefined;
};

export interface SendOutboundResult {
  readonly refused?: "opted_out" | "agent_sending_disabled";
  readonly refusedReason?: string;
  readonly provider?: "twilio" | "mock";
  readonly externalMessageId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly eventId?: string;
  readonly status?: string;
  readonly reason?: string;
}

// Send an outbound message on behalf of a household. The one
// place agent-authored and manager-authored sends converge.
// Applies the consent gate + the manager-mediated-only gate;
// refused sends return { refused: <reason>, ... } with no
// messaging_event recorded and no Twilio API call made.
export const sendOutboundMessage = async (
  db: Db,
  input: SendOutboundInput,
): Promise<SendOutboundResult> => {
  const endpoints = contactEndpointRepo(db);
  const events = messagingEventRepo(db);
  const sessions = conversationSessionRepo(db);
  const households = householdRepo(db);

  // Manager-mediated-only gate. Agent-authored sends need the
  // household to have explicitly opted in — even when the policy
  // engine allowed the tool call. This is defense in depth
  // catching (a) policy misconfigs that grant execute on
  // communication actions, (b) code paths that bypass the policy
  // engine, and (c) future tools that forget to route through
  // approvals. Manager-authored and system-authored sends
  // (verification confirmations, STOP acks) are never gated.
  if (input.authoredBy?.type === "agent") {
    const hh = households.get(input.householdId);
    if (!hh?.agentSendingEnabled) {
      input.logger?.info(
        "outbound refused: agent-authored send blocked by household policy",
        {
          householdId: input.householdId,
          channel: input.channel,
          to: input.to,
          authoredBy: input.authoredBy,
        },
      );
      return {
        refused: "agent_sending_disabled",
        refusedReason:
          "household.agentSendingEnabled is false; agent-authored outbound is refused at the wire",
      };
    }
  }

  const ep = endpoints.resolve(input.channel, input.to);
  if (ep && ep.householdId === input.householdId && ep.consentStatus === "opted_out") {
    return {
      refused: "opted_out",
      refusedReason: `opted_out_at_${ep.consentRecordedAt ?? "unknown_time"}`,
    };
  }

  const sender = resolveTwilioSender(db, input.householdId);
  // sendTwilioMessage accepts sms | whatsapp; imessage/email
  // never reach this codepath (routed through email tools), but
  // narrow explicitly so tsc is satisfied.
  const twilioChannel: "sms" | "whatsapp" =
    input.channel === "whatsapp" ? "whatsapp" : "sms";
  const cb = conciergeStatusCallback();
  const out = await sendTwilioMessage(
    sender as never,
    {
      channel: twilioChannel,
      to: input.to,
      body: input.body,
      ...(cb ? { statusCallback: cb } : {}),
    },
    ...(input.logger ? [{ logger: input.logger }] as const : []),
  );

  // Auto-attach to the recipient's open conversation session so
  // the reply lands in the running history — the next inbound
  // turn sees this outbound as prior agent context.
  let sessionId: string | undefined;
  const recipEp = ep ?? endpoints.resolve(input.channel, input.to);
  if (recipEp) {
    const open = sessions.listOpenForEndpoint(recipEp.id);
    sessionId = open[0]?.id;
  }

  const record = events.record({
    householdId: input.householdId,
    direction: "outbound",
    channel: input.channel,
    provider: out.provider,
    externalMessageId: out.externalMessageId,
    fromAddress: out.from,
    toAddress: out.to,
    body: input.body,
    ...(sessionId ? { sessionId } : {}),
    ...(input.authoredBy && {
      authoredByType: input.authoredBy.type,
      authoredById: input.authoredBy.id,
      ...(input.authoredBy.label ? { authoredByLabel: input.authoredBy.label } : {}),
    }),
  });

  return {
    provider: out.provider,
    externalMessageId: out.externalMessageId,
    from: out.from,
    to: out.to,
    eventId: record.row.id,
    ...(out.status ? { status: out.status } : {}),
    ...(out.reason ? { reason: out.reason } : {}),
  };
};

export interface SendOutboundEmailInput {
  readonly householdId: HouseholdId;
  readonly toName: string;
  readonly toAddress: string;
  readonly subject: string;
  readonly body: string;
  // RFC 5322 Message-ID of the message being replied to.
  readonly inReplyToRef?: string;
  // Gmail-side thread id — server-side threading.
  readonly threadId?: string;
  readonly authoredBy?: {
    // "agent" is included here so a future agent-side email path
    // (e.g. an email autoresponder tool that skips the current
    // trySendViaGmail-directly path) still hits the same gate.
    // No caller passes "agent" today; if you're wiring one, check
    // that the household's agentSendingEnabled flag is on before
    // firing this function.
    readonly type: "manager" | "agent" | "system";
    readonly id: string;
    readonly label?: string;
  };
  readonly logger?: { info: (msg: string, ctx?: unknown) => void };
}

export interface SendOutboundEmailResult {
  readonly provider: "gmail" | "mock";
  readonly sentMessageId: string;
  readonly threadId?: string;
  readonly messageIdHeader?: string;
  readonly from: string;
  readonly inboxMessageId: string;
  readonly reason?: string;
  readonly refused?: "gmail_not_connected" | "agent_sending_disabled";
}

// Manager-authored email send. Reuses the agent tool's Gmail
// helper so the RFC-822 build + auth stay in one place, then
// records the outbound row in inbox_messages with direction=
// "outbound" so the customer-activity timeline reflects it
// without waiting for the next SENT sync.
export const sendOutboundEmail = async (
  db: Db,
  input: SendOutboundEmailInput,
): Promise<SendOutboundEmailResult> => {
  const credentials = credentialRepo(db);
  const inbox = inboxRepo(db);
  const households = householdRepo(db);

  // Same manager-mediated gate the SMS path uses. Refuse
  // agent-authored email sends when the household hasn't opted
  // in, no matter what the policy engine said upstream.
  if (input.authoredBy?.type === "agent") {
    const hh = households.get(input.householdId);
    if (!hh?.agentSendingEnabled) {
      input.logger?.info(
        "outbound email refused: agent-authored send blocked by household policy",
        {
          householdId: input.householdId,
          toAddress: input.toAddress,
          authoredBy: input.authoredBy,
        },
      );
      return {
        provider: "mock",
        sentMessageId: "",
        from: "",
        inboxMessageId: "",
        refused: "agent_sending_disabled",
      };
    }
  }

  const ctx = {
    householdId: input.householdId,
    authorityId: undefined,
    readCredential: (provider: string) =>
      credentials.getSecret(input.householdId, provider),
    persistAccessToken: (id: string, at: string, exp: string) =>
      credentials.updateAccessToken(id, at, exp),
    proposedBy: { actor: "manager_email_send", version: "0.1.0" },
    ...(input.logger ? { logger: input.logger } : {}),
  };

  let sent: Awaited<ReturnType<typeof trySendViaGmail>> = null;
  try {
    sent = await trySendViaGmail(ctx, {
      toName: input.toName,
      toAddress: input.toAddress,
      subject: input.subject,
      body: input.body,
      ...(input.inReplyToRef ? { inReplyToRef: input.inReplyToRef } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
  } catch (err) {
    input.logger?.info("manager gmail send failed — mock fallback", {
      error: (err as Error).message,
    });
  }

  if (!sent) {
    // No gmail credential (or the SDK threw) — refuse cleanly so
    // the console can surface "Connect Google first" instead of
    // silently succeeding with a mock id. The customer-activity
    // timeline stays empty rather than fake-showing a send.
    return {
      provider: "mock",
      sentMessageId: "",
      from: "",
      inboxMessageId: "",
      refused: "gmail_not_connected",
    };
  }

  // Pull from_address off the gmail credential so the from
  // address on the persisted inbox row matches what actually
  // landed on the wire.
  const cred = credentials.getSecret(input.householdId, "gmail");
  const fromAddress =
    (cred?.credential as { from_address?: string } | undefined)?.from_address ??
    "unknown@unknown";
  const recorded = inbox.upsertExternal({
    householdId: input.householdId,
    externalProvider: "gmail",
    externalMessageId: sent.sentMessageId,
    ...(sent.threadId ? { externalThreadId: sent.threadId } : {}),
    messageIdHeader: sent.messageIdHeader,
    direction: "outbound",
    fromName: "",
    fromAddress,
    toAddress: input.toAddress,
    subject: input.subject,
    body: input.body,
    receivedAt: new Date().toISOString(),
  });

  return {
    provider: sent.provider,
    sentMessageId: sent.sentMessageId,
    ...(sent.threadId ? { threadId: sent.threadId } : {}),
    messageIdHeader: sent.messageIdHeader,
    from: fromAddress,
    inboxMessageId: recorded.row.id,
  };
};
