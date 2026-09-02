"use client";

import { useState, useTransition } from "react";
import { sendMessage } from "./actions";
import type { HouseholdId } from "@atelier/domain";

interface MessagingEvent {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  provider: string;
  fromAddress: string;
  toAddress: string;
  body: string;
  receivedAt: string;
  plannerRunId: string | null;
  deliveryStatus: string | null;
  deliveryStatusAt: string | null;
  deliveryErrorCode: string | null;
}

// Small badge for Twilio-shaped delivery statuses. Only rendered
// on outbound rows — inbound is a delivery receipt for the
// customer, not for us.
const DeliveryBadge = ({
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

export function MessagingEvents({
  householdId,
  events,
}: {
  householdId: HouseholdId;
  events: MessagingEvent[];
}) {
  const [replyOpen, setReplyOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (events.length === 0) return null;
  return (
    <div>
      <div className="section-head">
        <h2>Recent messages</h2>
        <span className="mono">{events.length}</span>
      </div>
      <ul className="messaging-events">
        {events.map((e) => (
          <li key={e.id} className={`messaging-event dir-${e.direction}`}>
            <div className="messaging-meta">
              <span className={`tag tag-${e.channel}`}>{e.channel}</span>
              <span className="tag">{e.direction}</span>
              <span className="muted">{e.provider}</span>
              <span className="mono">{new Date(e.receivedAt).toLocaleString()}</span>
              {e.plannerRunId ? (
                <span className="mono muted">run {e.plannerRunId.slice(0, 10)}</span>
              ) : null}
              {e.direction === "outbound" ? (
                <DeliveryBadge
                  status={e.deliveryStatus}
                  at={e.deliveryStatusAt}
                  errorCode={e.deliveryErrorCode}
                />
              ) : null}
            </div>
            <div className="messaging-addresses">
              <span className="mono">{e.fromAddress}</span>
              <span className="muted">→</span>
              <span className="mono">{e.toAddress}</span>
            </div>
            <p className="messaging-body">{e.body}</p>
            {e.direction === "inbound" &&
            (e.channel === "sms" || e.channel === "whatsapp") ? (
              replyOpen === e.id ? (
                <form
                  className="reply-form"
                  onSubmit={(evt) => {
                    evt.preventDefault();
                    startTransition(async () => {
                      const res = await sendMessage(householdId, {
                        channel: e.channel as "sms" | "whatsapp",
                        to: e.fromAddress,
                        body: draft,
                      });
                      setStatus(res.message);
                      if (!res.message.startsWith("Error")) {
                        setDraft("");
                        setReplyOpen(null);
                      }
                    });
                  }}
                >
                  <textarea
                    value={draft}
                    onChange={(x) => setDraft(x.target.value)}
                    placeholder="Reply…"
                    rows={2}
                    disabled={isPending}
                    required
                  />
                  <div className="reply-actions">
                    <button type="submit" disabled={isPending || !draft}>
                      Send
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={isPending}
                      onClick={() => {
                        setReplyOpen(null);
                        setDraft("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setReplyOpen(e.id);
                    setStatus(null);
                  }}
                >
                  Reply
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {status ? <p className="mono muted">{status}</p> : null}
    </div>
  );
}
