"use client";

import { useMemo, useState, useTransition } from "react";
import { sendMessage } from "./actions";
import type { HouseholdId } from "@atelier/domain";
import type { Person } from "./invite-customer";

// SMS-style thread view — one card per contact endpoint, bubbles
// grouped by conversation session (open first, then closed by
// most-recent-activity). Consolidates the concierge-line story
// the flat "recent messages" panel couldn't tell: whose thread
// is this, who's said what, when did the customer opt out, what
// hasn't Twilio confirmed delivery on. One composer per thread
// at the bottom for the manager to reply.

interface MessagingEvent {
  id: string;
  endpointId: string | null;
  sessionId: string | null;
  direction: "inbound" | "outbound";
  channel: "sms" | "whatsapp" | "imessage" | "email" | string;
  provider: string;
  fromAddress: string;
  toAddress: string;
  body: string;
  receivedAt: string;
  plannerRunId: string | null;
  deliveryStatus: string | null;
  deliveryStatusAt: string | null;
  deliveryErrorCode: string | null;
  authoredByType: "manager" | "agent" | "system" | null;
  authoredById: string | null;
  authoredByLabel: string | null;
}

interface Endpoint {
  id: string;
  channel: "sms" | "whatsapp" | "imessage" | "email";
  address: string;
  label: string | null;
  principalId: string | null;
  createdAt: string;
  revokedAt: string | null;
  consentStatus: "unknown" | "opted_in" | "opted_out";
  consentRecordedAt: string | null;
  consentSource: string | null;
}

export function ConversationThreads({
  householdId,
  events,
  endpoints,
  people,
}: {
  householdId: HouseholdId;
  events: MessagingEvent[];
  endpoints: Endpoint[];
  people: {
    principal: Person[];
    member: Person[];
    staff: Person[];
    contact: Person[];
  };
}) {
  // Person index for endpoint → name resolution.
  const personName = useMemo(() => {
    const map = new Map<string, string>();
    for (const kind of ["principal", "member", "staff", "contact"] as const) {
      for (const p of people[kind]) {
        const d = p.data as { fullName?: string; name?: string };
        const name = d.fullName ?? d.name;
        if (name) map.set(p.id, name);
      }
    }
    return map;
  }, [people]);

  // Group events by endpointId.
  const byEndpoint = useMemo(() => {
    const map = new Map<string, MessagingEvent[]>();
    for (const e of events) {
      if (!e.endpointId) continue;
      const arr = map.get(e.endpointId) ?? [];
      arr.push(e);
      map.set(e.endpointId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    }
    return map;
  }, [events]);

  // Sort endpoints by most recent activity, active first, then
  // revoked at the bottom.
  const orderedEndpoints = useMemo(() => {
    const withActivity = endpoints.map((ep) => {
      const arr = byEndpoint.get(ep.id) ?? [];
      const last = arr[arr.length - 1];
      return {
        ep,
        lastAt: last?.receivedAt ?? ep.createdAt,
        eventCount: arr.length,
      };
    });
    return withActivity.sort((a, b) => {
      const aRev = a.ep.revokedAt ? 1 : 0;
      const bRev = b.ep.revokedAt ? 1 : 0;
      if (aRev !== bRev) return aRev - bRev;
      return b.lastAt.localeCompare(a.lastAt);
    });
  }, [endpoints, byEndpoint]);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const [_isPending, startTransition] = useTransition();

  if (endpoints.length === 0) {
    return null;
  }

  const anyEvents = events.length > 0;
  if (!anyEvents && orderedEndpoints.every((x) => x.eventCount === 0)) {
    return null;
  }

  return (
    <div>
      <div className="section-head">
        <h2>Conversations</h2>
        <span className="mono">{orderedEndpoints.length}</span>
      </div>
      <div className="thread-grid">
        {orderedEndpoints.map(({ ep, eventCount }) => {
          if (eventCount === 0 && ep.revokedAt) return null;
          const name = ep.principalId ? personName.get(ep.principalId) : null;
          const thread = byEndpoint.get(ep.id) ?? [];
          const isSms = ep.channel === "sms" || ep.channel === "whatsapp";
          return (
            <div
              key={ep.id}
              className={`thread-card thread-consent-${ep.consentStatus}${ep.revokedAt ? " thread-revoked" : ""}`}
            >
              <div className="thread-header">
                <div className="thread-title">
                  <span className="thread-name">
                    {name ?? "(unassigned profile)"}
                  </span>
                  <span className={`tag tag-${ep.channel}`}>{ep.channel}</span>
                </div>
                <div className="thread-meta">
                  <span className="mono">{ep.address}</span>
                  {ep.label ? <span className="muted">· {ep.label}</span> : null}
                  <ConsentPill status={ep.consentStatus} at={ep.consentRecordedAt} />
                  {ep.revokedAt ? <span className="tag tag-revoked">revoked</span> : null}
                </div>
              </div>

              {thread.length === 0 ? (
                <div className="empty">No messages yet.</div>
              ) : (
                <ol className="thread-bubbles">
                  {thread.map((e, i) => {
                    const prev = thread[i - 1];
                    const showSessionBreak =
                      prev && prev.sessionId !== e.sessionId;
                    return (
                      <li key={e.id} className={`thread-bubble bubble-${e.direction}`}>
                        {showSessionBreak ? (
                          <div className="thread-session-break">
                            <span className="muted">— new session —</span>
                          </div>
                        ) : null}
                        <div className="bubble-body">{e.body || "(empty)"}</div>
                        <div className="bubble-meta">
                          {e.direction === "outbound" ? (
                            <AuthorPill
                              type={e.authoredByType}
                              label={e.authoredByLabel}
                            />
                          ) : null}
                          <span className="mono">
                            {new Date(e.receivedAt).toLocaleString()}
                          </span>
                          {e.direction === "outbound" ? (
                            <DeliveryPill
                              status={e.deliveryStatus}
                              at={e.deliveryStatusAt}
                              errorCode={e.deliveryErrorCode}
                            />
                          ) : null}
                          {e.plannerRunId ? (
                            <span
                              className="muted mono"
                              title="Linked planner run"
                            >
                              run {e.plannerRunId.slice(0, 8)}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              {isSms && !ep.revokedAt && ep.consentStatus !== "opted_out" ? (
                <form
                  className="thread-composer"
                  onSubmit={(evt) => {
                    evt.preventDefault();
                    const body = drafts[ep.id] ?? "";
                    if (!body.trim()) return;
                    setPendingFor(ep.id);
                    startTransition(async () => {
                      const res = await sendMessage(householdId, {
                        channel: ep.channel as "sms" | "whatsapp",
                        to: ep.address,
                        body,
                      });
                      setStatuses((s) => ({ ...s, [ep.id]: res.message }));
                      if (!res.message.startsWith("Error")) {
                        setDrafts((d) => ({ ...d, [ep.id]: "" }));
                      }
                      setPendingFor(null);
                    });
                  }}
                >
                  <textarea
                    value={drafts[ep.id] ?? ""}
                    onChange={(x) =>
                      setDrafts((d) => ({ ...d, [ep.id]: x.target.value }))
                    }
                    placeholder={`Reply as manager to ${name ?? ep.address}…`}
                    rows={2}
                    disabled={pendingFor === ep.id}
                  />
                  <div className="thread-composer-actions">
                    <button
                      type="submit"
                      disabled={
                        pendingFor === ep.id || !(drafts[ep.id] ?? "").trim()
                      }
                    >
                      Send
                    </button>
                    {statuses[ep.id] ? (
                      <span className="mono muted">{statuses[ep.id]}</span>
                    ) : null}
                  </div>
                </form>
              ) : ep.consentStatus === "opted_out" ? (
                <div className="thread-composer-disabled">
                  Recipient opted out — outbound refused. Reply from another
                  channel or wait for the customer to text START.
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ConsentPill = ({
  status,
  at,
}: {
  status: "unknown" | "opted_in" | "opted_out";
  at: string | null;
}) => {
  const cls =
    status === "opted_in"
      ? { background: "#dcfce7", color: "#166534" }
      : status === "opted_out"
        ? { background: "#fee2e2", color: "#991b1b" }
        : { background: "#fef3c7", color: "#92400e" };
  const label =
    status === "opted_in" ? "opted in" : status === "opted_out" ? "opted out" : "consent unknown";
  return (
    <span
      className="tag"
      style={cls}
      title={at ? `${label} ${new Date(at).toLocaleString()}` : label}
    >
      {label}
    </span>
  );
};

const AuthorPill = ({
  type,
  label,
}: {
  type: "manager" | "agent" | "system" | null;
  label: string | null;
}) => {
  if (!type) return null;
  // Colour per author type — matches the mental model: managers
  // are people (slate), agents are software (violet), system is
  // internal (gray).
  const cls =
    type === "manager"
      ? { background: "#e2e8f0", color: "#334155" }
      : type === "agent"
        ? { background: "#ede9fe", color: "#5b21b6" }
        : { background: "#f3f4f6", color: "#4b5563" };
  const text =
    type === "manager"
      ? `${label ?? "manager"} · manager`
      : type === "agent"
        ? `${label ?? "agent"} · agent`
        : "system";
  return (
    <span className="tag" style={cls}>
      {text}
    </span>
  );
};

const DeliveryPill = ({
  status,
  at,
  errorCode,
}: {
  status: string | null;
  at: string | null;
  errorCode: string | null;
}) => {
  if (!status) return null;
  const cls =
    status === "delivered" || status === "read"
      ? { background: "#dcfce7", color: "#166534" }
      : status === "sent" || status === "queued" || status === "accepted"
        ? { background: "#e0e7ff", color: "#3730a3" }
        : { background: "#fee2e2", color: "#991b1b" };
  const title = [
    at ? `at ${new Date(at).toLocaleString()}` : null,
    errorCode ? `error ${errorCode}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="tag" style={cls} title={title || undefined}>
      {status}
      {errorCode ? ` (${errorCode})` : ""}
    </span>
  );
};
