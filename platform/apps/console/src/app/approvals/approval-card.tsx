"use client";

import { useState, useTransition } from "react";
import type { ApprovalItem, HouseholdId } from "@atelier/domain";
import { approveAction, rejectAction } from "./actions";

export function ApprovalCard({
  approval,
  householdName,
}: {
  approval: ApprovalItem;
  householdName?: string;
}) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const busy = pending;

  return (
    <article className="approval-card card">
      <header className="approval-head">
        <div>
          {householdName ? (
            <p className="approval-household">{householdName}</p>
          ) : null}
          <p className="approval-summary">{approval.summary}</p>
          <p className="approval-meta">
            <span className="tag">{approval.kind.replace("_", " ")}</span>
            <span className="mono">{approval.actionClass}</span>
            {approval.amountUsd !== undefined ? (
              <span className="mono">${approval.amountUsd.toFixed(2)}</span>
            ) : null}
            <span className="mono">
              from {approval.proposedBy.agent}@{approval.proposedBy.agentVersion}
            </span>
            {approval.origin ? (
              <span className={`tag origin-${approval.origin}`}>
                {approval.origin}
                {approval.originBy ? ` · ${approval.originBy}` : ""}
              </span>
            ) : null}
          </p>
          {approval.reasons.length > 0 ? (
            <p className="approval-reasons mono">
              {approval.reasons.join(" · ")}
            </p>
          ) : null}
        </div>
      </header>

      <details className="approval-details">
        <summary>Proposed inputs</summary>
        <pre className="mono">{JSON.stringify(approval.toolInputs, null, 2)}</pre>
      </details>

      <div className="approval-actions">
        <input
          type="text"
          placeholder="Note (optional to approve, required to reject)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => {
            setStatus(null);
            startTransition(async () => {
              const res = await approveAction(
                approval.householdId as HouseholdId,
                approval.id,
                note,
              );
              setStatus(res.message);
            });
          }}
        >
          Approve
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={busy || !note.trim()}
          onClick={() => {
            setStatus(null);
            startTransition(async () => {
              const res = await rejectAction(
                approval.householdId as HouseholdId,
                approval.id,
                note,
              );
              setStatus(res.message);
            });
          }}
        >
          Reject
        </button>
      </div>
      {status ? <p className="hint">{status}</p> : null}
    </article>
  );
}
