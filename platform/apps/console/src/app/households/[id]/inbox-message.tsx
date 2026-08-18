"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HouseholdId } from "@atelier/domain";
import type { InboxMessageSummary } from "@/lib/api";
import { processInboxMessage } from "./actions";

export function InboxMessageCard({
  message,
  householdId,
}: {
  message: InboxMessageSummary;
  householdId: HouseholdId;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <article className="card inbox-card">
      <div className="inbox-head">
        <div>
          <p className="inbox-from">
            {message.fromName} <span className="mono">&lt;{message.fromAddress}&gt;</span>
          </p>
          <p className="inbox-subject">{message.subject}</p>
        </div>
        <div className="inbox-tags">
          <span
            className={`tag ${
              message.status === "replied"
                ? "confirmed"
                : message.status === "triaged"
                  ? "candidate"
                  : "retired"
            }`}
          >
            {message.status}
          </span>
          {message.urgency ? <span className="mono">{message.urgency}</span> : null}
          {message.recipientClass ? (
            <span className="mono">{message.recipientClass}</span>
          ) : null}
        </div>
      </div>
      <p className="inbox-body">{message.body}</p>
      <div className="inbox-actions">
        <button
          className="btn"
          type="button"
          disabled={pending}
          onClick={() => {
            setStatus(null);
            startTransition(async () => {
              const res = await processInboxMessage(householdId, {
                messageId: message.id,
                fromName: message.fromName,
                fromAddress: message.fromAddress,
                subject: message.subject,
                body: message.body,
              });
              setStatus(res.message);
              router.refresh();
            });
          }}
        >
          {pending ? "Processing..." : "Process with Inbox agent"}
        </button>
        {status ? <p className="hint">{status}</p> : null}
      </div>
    </article>
  );
}
