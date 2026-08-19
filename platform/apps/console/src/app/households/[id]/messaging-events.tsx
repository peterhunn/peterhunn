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
}

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
