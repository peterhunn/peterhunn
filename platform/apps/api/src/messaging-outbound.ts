import {
  contactEndpointRepo,
  conversationSessionRepo,
  credentialRepo,
  messagingEventRepo,
  type Db,
  type MessagingChannel,
} from "@atelier/db";
import { sendTwilioMessage } from "@atelier/agents";
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
}

export interface SendOutboundResult {
  readonly refused?: "opted_out";
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
// Applies the consent gate; refused sends return
// { refused: "opted_out", ... } with no messaging_event
// recorded and no Twilio API call made.
export const sendOutboundMessage = async (
  db: Db,
  input: SendOutboundInput,
): Promise<SendOutboundResult> => {
  const endpoints = contactEndpointRepo(db);
  const events = messagingEventRepo(db);
  const sessions = conversationSessionRepo(db);

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
  const out = await sendTwilioMessage(
    sender as never,
    { channel: twilioChannel, to: input.to, body: input.body },
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
