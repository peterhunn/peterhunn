"use client";

import { useState, useTransition } from "react";
import type { HouseholdId } from "@atelier/domain";
import type { Person } from "./invite-customer";
import {
  loadCustomerActivity,
  sendEmail,
  sendMessage,
  type CustomerActivityResponse,
} from "./actions";

// Per-customer unified activity — SMS + email interleaved by
// receivedAt for one principal at a time. Fetches lazily on
// expand so a household page with 12 people doesn't do 12 joins
// on load. The raw stores stay separate; this panel is a read
// projection.

type ActivityItem = CustomerActivityResponse["items"][number];

const personName = (p: Person): string => {
  const d = p.data as { fullName?: string; name?: string };
  return d.fullName ?? d.name ?? "(unnamed)";
};

const sourceLabel = (s: ActivityItem["source"]): string =>
  s === "sms" ? "SMS" : s === "whatsapp" ? "WhatsApp" : s === "imessage" ? "iMessage" : "Email";

type Channel = "sms" | "email";

interface Endpoint {
  id: string;
  channel: "sms" | "whatsapp" | "imessage" | "email";
  address: string;
  consentStatus: "unknown" | "opted_in" | "opted_out";
}

// Pick the reply channel + address the composer should default to.
// Rule: most recent INBOUND item wins — if the last thing the
// customer did was text, reply by SMS; if they emailed, reply by
// email. Falls back to the first available endpoint of either kind
// if there's no inbound history. Returns null when neither exists
// or an SMS endpoint is opted-out (opted-out numbers can't receive
// outbound at all).
const pickReplyChannel = (
  items: ActivityItem[],
  endpoints: Endpoint[],
): { channel: Channel; address: string; endpoint: Endpoint | null } | null => {
  const smsEp = endpoints.find(
    (e) => e.channel === "sms" && e.consentStatus !== "opted_out",
  );
  const emailEp = endpoints.find((e) => e.channel === "email");
  const lastInbound = items.find((i) => i.direction === "inbound");
  if (lastInbound?.source === "sms" && smsEp) {
    return { channel: "sms", address: smsEp.address, endpoint: smsEp };
  }
  if (lastInbound?.source === "email" && emailEp) {
    return { channel: "email", address: emailEp.address, endpoint: emailEp };
  }
  if (smsEp) return { channel: "sms", address: smsEp.address, endpoint: smsEp };
  if (emailEp)
    return { channel: "email", address: emailEp.address, endpoint: emailEp };
  return null;
};

// Best-effort subject when the manager doesn't type one — pick the
// most recent email's subject and prefix Re: if it doesn't already
// start with it. Fallback to a bland default.
const defaultSubject = (items: ActivityItem[]): string => {
  const lastEmail = items.find((i) => i.source === "email");
  const subj = (lastEmail?.detail?.["subject"] as string | undefined) ?? "";
  if (!subj) return "Following up";
  return /^re:/i.test(subj) ? subj : `Re: ${subj}`;
};

// Find the most recent inbound email in the timeline. That's the
// message we're threading against — its Message-ID becomes
// In-Reply-To / References, and its Gmail threadId is passed to
// the Gmail send so the outbound lands in the same conversation.
const findEmailReplyTarget = (
  items: ActivityItem[],
): { inReplyToRef?: string; threadId?: string } => {
  const target = items.find(
    (i) => i.source === "email" && i.direction === "inbound",
  );
  if (!target) return {};
  const detail = target.detail ?? {};
  const inReplyToRef =
    typeof detail["messageIdHeader"] === "string"
      ? (detail["messageIdHeader"] as string)
      : undefined;
  const threadId =
    typeof detail["externalThreadId"] === "string"
      ? (detail["externalThreadId"] as string)
      : undefined;
  const out: { inReplyToRef?: string; threadId?: string } = {};
  if (inReplyToRef) out.inReplyToRef = inReplyToRef;
  if (threadId) out.threadId = threadId;
  return out;
};

function ReplyComposer({
  householdId,
  personName: name,
  items,
  endpoints,
  onSent,
}: {
  householdId: HouseholdId;
  personName: string;
  items: ActivityItem[];
  endpoints: Endpoint[];
  onSent: () => void;
}) {
  const pick = pickReplyChannel(items, endpoints);
  const [channel, setChannel] = useState<Channel>(pick?.channel ?? "sms");
  const [subject, setSubject] = useState<string>(defaultSubject(items));
  const [body, setBody] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const target = endpoints.find((e) =>
    channel === "sms" ? e.channel === "sms" : e.channel === "email",
  );

  if (!pick) {
    return (
      <div className="activity-composer-disabled muted">
        No SMS or email endpoint registered for this person. Add one from the
        Messaging endpoints panel to reply.
      </div>
    );
  }

  const disabledReason =
    channel === "sms" && target?.consentStatus === "opted_out"
      ? "This number opted out. Ask the customer to text START to opt back in."
      : !target
        ? `No ${channel === "sms" ? "SMS" : "email"} endpoint registered.`
        : null;

  return (
    <form
      className="activity-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim() || !target || disabledReason) return;
        startTransition(async () => {
          if (channel === "sms") {
            const res = await sendMessage(householdId, {
              channel: "sms",
              to: target.address,
              body,
            });
            setMessage(res.message);
            if (!res.message.startsWith("Error")) {
              setBody("");
              onSent();
            }
          } else {
            const threading = findEmailReplyTarget(items);
            const res = await sendEmail(householdId, {
              toName: name,
              toAddress: target.address,
              subject: subject || "Following up",
              body,
              ...threading,
            });
            setMessage(res.message);
            if (!res.message.startsWith("Error")) {
              setBody("");
              onSent();
            }
          }
        });
      }}
    >
      <div className="activity-composer-head">
        <label>
          <input
            type="radio"
            name={`ch-${target?.id ?? "none"}`}
            checked={channel === "sms"}
            onChange={() => setChannel("sms")}
            disabled={!endpoints.some((e) => e.channel === "sms")}
          />
          <span>SMS</span>
        </label>
        <label>
          <input
            type="radio"
            name={`ch-${target?.id ?? "none"}`}
            checked={channel === "email"}
            onChange={() => setChannel("email")}
            disabled={!endpoints.some((e) => e.channel === "email")}
          />
          <span>Email</span>
        </label>
        {target ? (
          <span className="mono muted">→ {target.address}</span>
        ) : null}
      </div>
      {channel === "email" ? (
        <input
          type="text"
          className="activity-composer-subject"
          value={subject}
          placeholder="Subject"
          onChange={(e) => setSubject(e.target.value)}
          disabled={isPending}
        />
      ) : null}
      <textarea
        value={body}
        placeholder={
          channel === "sms"
            ? `SMS reply to ${name}…`
            : `Email reply to ${name}…`
        }
        rows={channel === "email" ? 4 : 2}
        onChange={(e) => setBody(e.target.value)}
        disabled={isPending || Boolean(disabledReason)}
      />
      <div className="activity-composer-actions">
        <button
          type="submit"
          disabled={isPending || !body.trim() || Boolean(disabledReason)}
        >
          Send {channel === "sms" ? "SMS" : "email"}
        </button>
        {disabledReason ? (
          <span className="mono muted">{disabledReason}</span>
        ) : message ? (
          <span className="mono muted">{message}</span>
        ) : null}
      </div>
    </form>
  );
}

export function CustomerActivity({
  householdId,
  people,
}: {
  householdId: HouseholdId;
  people: {
    principal: Person[];
    member: Person[];
    staff: Person[];
    contact: Person[];
  };
}) {
  // Only principals + members are treated as "customers" the manager
  // consolidates activity for. Staff and vendors have their own
  // channels but aren't the customer's account.
  const customers = [...people.principal, ...people.member];
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cache, setCache] = useState<
    Record<string, CustomerActivityResponse | { error: string }>
  >({});
  const [isPending, startTransition] = useTransition();

  if (customers.length === 0) return null;

  const load = (id: string): void => {
    startTransition(async () => {
      const res = await loadCustomerActivity(householdId, id);
      setCache((prev) => ({
        ...prev,
        [id]: res.data ?? { error: res.message },
      }));
    });
  };
  const toggle = (id: string): void => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!cache[id]) load(id);
  };

  return (
    <div>
      <div className="section-head">
        <h2>Customer activity</h2>
        <span className="mono">{customers.length}</span>
      </div>
      <p className="subtitle" style={{ marginTop: 0 }}>
        SMS and email consolidated per person.
      </p>
      <ul className="activity-people">
        {customers.map((p) => {
          const open = expanded === p.id;
          const cached = cache[p.id];
          return (
            <li key={p.id} className="activity-person">
              <button
                type="button"
                className="activity-person-header"
                onClick={() => toggle(p.id)}
              >
                <span className="activity-person-name">{personName(p)}</span>
                <span className="mono muted">
                  {cached && !("error" in cached)
                    ? `${cached.items.length} · sms ${cached.counts.sms} · email ${cached.counts.email}`
                    : "···"}
                </span>
                <span className="mono muted">{open ? "hide" : "show"}</span>
              </button>
              {open ? (
                <div className="activity-body">
                  {!cached ? (
                    <span className="muted">Loading…</span>
                  ) : "error" in cached ? (
                    <span className="muted">{cached.error}</span>
                  ) : cached.items.length === 0 ? (
                    <span className="muted">
                      No SMS or email tied to this person yet.
                    </span>
                  ) : (
                    <>
                      <div className="activity-endpoints">
                        {cached.endpoints.map((e) => (
                          <span key={e.id} className={`tag tag-${e.channel}`}>
                            {e.channel} · <span className="mono">{e.address}</span>
                          </span>
                        ))}
                      </div>
                      <ol className="activity-items">
                        {cached.items.map((item) => (
                          <li
                            key={`${item.refKind}-${item.refId}`}
                            className={`activity-item activity-${item.source} activity-${item.direction}`}
                          >
                            <div className="activity-item-head">
                              <span className={`tag tag-${item.source}`}>
                                {sourceLabel(item.source)}
                              </span>
                              <span className="mono muted">{item.direction}</span>
                              <span className="mono muted">
                                {new Date(item.at).toLocaleString()}
                              </span>
                            </div>
                            <div className="activity-item-body">{item.summary}</div>
                          </li>
                        ))}
                      </ol>
                      <ReplyComposer
                        householdId={householdId}
                        personName={personName(p)}
                        items={cached.items}
                        endpoints={cached.endpoints}
                        onSent={() => load(p.id)}
                      />
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {isPending ? (
        <span className="muted mono" style={{ display: "block", marginTop: 8 }}>
          Loading…
        </span>
      ) : null}
    </div>
  );
}
