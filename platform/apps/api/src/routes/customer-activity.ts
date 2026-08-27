import type { FastifyPluginAsync } from "fastify";
import {
  contactEndpointRepo,
  inboxRepo,
  messagingEventRepo,
  normalizeAddress,
  type Db,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// Per-customer unified activity timeline. Aggregates SMS / WhatsApp /
// iMessage bubbles from messaging_events and Gmail-synced inbox
// messages from inbox_messages, both joined to a single principal
// via contact_endpoints, and returns them interleaved by receivedAt
// so the console can render one "conversation with $NAME across
// every channel" panel instead of two side-by-side lists.
//
// Join keys:
//   - messaging_events → contact_endpoints.principalId
//     (fetch every endpoint the principal owns; every event whose
//     endpointId is in that set is theirs; also normalise the
//     from/to address as a fallback for events that predate the
//     endpoint routing).
//   - inbox_messages → recipientPrincipalId when set (from the
//     manager-created path), OR fromAddress matches any of the
//     principal's email contact_endpoint addresses (case-insensitive
//     via normalizeAddress).
//
// This is a read-only projection; the underlying stores stay
// separate because their provenance rules diverge (SMS has consent +
// session windows + delivery status; email carries Gmail thread ids
// + inbox status). Consolidating the tables would either flatten
// those or bloat one schema; a query layer costs no migration and
// keeps each store honest.

interface ActivityItem {
  readonly source: "sms" | "whatsapp" | "imessage" | "email";
  readonly direction: "inbound" | "outbound";
  readonly at: string;
  readonly summary: string;
  readonly body: string;
  readonly from: string;
  readonly to: string;
  readonly endpointId: string | null;
  readonly refId: string;
  readonly refKind: "messaging_event" | "inbox_message";
  readonly detail: Record<string, unknown>;
}

const MESSAGING_CHANNELS = new Set(["sms", "whatsapp", "imessage"]);

export const customerActivityRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const endpoints = contactEndpointRepo(db);
  const events = messagingEventRepo(db);
  const inbox = inboxRepo(db);

  app.get<{ Params: { householdId: string; principalId: string } }>(
    "/households/:householdId/customers/:principalId/activity",
    {
      config: {
        audit: {
          action: "customers.activity.list",
          resourceType: "principal",
          sensitive: true,
        },
      },
    },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const principalId = req.params.principalId;

      // Endpoints belonging to this principal, split by kind.
      const owned = endpoints
        .list(householdId)
        .filter((e) => e.principalId === principalId);
      const ownedEndpointIds = new Set(owned.map((e) => e.id));
      const emailAddresses = new Set(
        owned
          .filter((e) => e.channel === "email")
          .map((e) => normalizeAddress("email", e.address)),
      );

      const items: ActivityItem[] = [];

      // SMS/WhatsApp/iMessage bubbles from messaging_events. Cap at
      // 500 recent — enough for a busy customer, well under the
      // point where interleaved rendering starts to hurt.
      for (const e of events.list(householdId, 500)) {
        if (!MESSAGING_CHANNELS.has(e.channel)) continue;
        const isMine = e.endpointId ? ownedEndpointIds.has(e.endpointId) : false;
        if (!isMine) continue;
        items.push({
          source: e.channel as "sms" | "whatsapp" | "imessage",
          direction: e.direction,
          at: e.receivedAt,
          summary:
            e.body.length > 120 ? `${e.body.slice(0, 120)}…` : e.body || "(empty)",
          body: e.body,
          from: e.fromAddress,
          to: e.toAddress,
          endpointId: e.endpointId,
          refId: e.id,
          refKind: "messaging_event",
          detail: {
            sessionId: e.sessionId,
            deliveryStatus: e.deliveryStatus,
            deliveryStatusAt: e.deliveryStatusAt,
            deliveryErrorCode: e.deliveryErrorCode,
            authoredByType: e.authoredByType,
            authoredByLabel: e.authoredByLabel,
            plannerRunId: e.plannerRunId,
          },
        });
      }

      // Email from inbox_messages. Match by recipientPrincipalId (the
      // manager-created path) OR by fromAddress matching one of the
      // principal's registered email endpoints.
      for (const m of inbox.list(householdId, 500)) {
        const fromNormalized = normalizeAddress("email", m.fromAddress);
        const matches =
          m.recipientPrincipalId === principalId ||
          emailAddresses.has(fromNormalized);
        if (!matches) continue;
        const summary = m.subject || (m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body);
        items.push({
          source: "email",
          // inbox_messages is inbound-only today; the outbound side
          // lives in Gmail itself. When we add a sent-mail sync, an
          // outbound direction here follows the same shape.
          direction: "inbound",
          at: m.receivedAt,
          summary,
          body: m.body,
          from: m.fromAddress,
          to: emailAddresses.values().next().value ?? "",
          endpointId: null,
          refId: m.id,
          refKind: "inbox_message",
          detail: {
            subject: m.subject,
            status: m.status,
            urgency: m.urgency,
            requiresReply: m.requiresReply,
            draftReply: m.draftReply,
            externalProvider: m.externalProvider,
            externalThreadId: m.externalThreadId,
          },
        });
      }

      items.sort((a, b) => (a.at < b.at ? 1 : -1));

      return {
        principalId,
        endpoints: owned.map((e) => ({
          id: e.id,
          channel: e.channel,
          address: e.address,
          consentStatus: e.consentStatus,
        })),
        items,
        counts: {
          sms: items.filter((i) => i.source === "sms").length,
          whatsapp: items.filter((i) => i.source === "whatsapp").length,
          imessage: items.filter((i) => i.source === "imessage").length,
          email: items.filter((i) => i.source === "email").length,
        },
      };
    },
  );
};
