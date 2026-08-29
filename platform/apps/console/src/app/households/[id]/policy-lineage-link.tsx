"use client";

import { useState, useTransition } from "react";
import { loadPolicyLineage, type PolicyLineage } from "./actions";
import type { HouseholdId } from "@atelier/domain";

// The Origin cell on the Policies table renders this. When the
// policy carries suggestion_lineage, clicking the tag fetches the
// full chain — basis policy + hydrated approvals — and shows it
// in a modal. Uses on-demand loading rather than server-side
// hydration because most policies won't be inspected on any given
// page view.
export function PolicyLineageLink({
  householdId,
  policyId,
  kind,
  approvalCount,
}: {
  householdId: HouseholdId;
  policyId: string;
  kind: "promote" | "demote";
  approvalCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PolicyLineage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const label =
    kind === "promote"
      ? `↑ from ${approvalCount} approval${approvalCount === 1 ? "" : "s"}`
      : `↓ from override pattern`;

  const onClick = () => {
    setOpen(true);
    if (data !== null) return; // Already loaded — just re-open the modal.
    startTransition(async () => {
      const res = await loadPolicyLineage(householdId, policyId);
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.message);
      }
    });
  };

  return (
    <>
      <button
        type="button"
        className="tag confirmed lineage-tag"
        onClick={onClick}
      >
        {label}
      </button>
      {open ? (
        <div className="modal-scrim" onClick={() => setOpen(false)}>
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-head">
              <h3>Policy lineage</h3>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
            {isPending && !data ? (
              <p className="muted">Loading…</p>
            ) : error ? (
              <p className="error">Error: {error}</p>
            ) : data ? (
              <LineageBody data={data} />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function LineageBody({ data }: { data: PolicyLineage }) {
  const { policy, lineage, basisPolicy, basisApprovals } = data;
  return (
    <div className="lineage-body">
      <section>
        <h4>This policy</h4>
        <p>
          <strong>{policy.label}</strong> — <span className="mono">{policy.domain}::{policy.actionClass}</span>
          {" "}
          on <span className="mono">{policy.subject}</span> at rung{" "}
          <span className="tag">{policy.autonomy}</span>
        </p>
        <p className="muted">
          Created {new Date(policy.createdAt).toLocaleString()} — adopted
          from a <strong>{lineage.kind}</strong> suggestion at{" "}
          {new Date(lineage.suggestedAt).toLocaleString()}.
        </p>
      </section>

      <section>
        <h4>Basis policy</h4>
        {basisPolicy ? (
          <p>
            <strong>{basisPolicy.label}</strong> —{" "}
            <span className="mono">{basisPolicy.id}</span>, previously at
            rung <span className="tag">{basisPolicy.autonomy}</span>
            {basisPolicy.revokedAt ? (
              <>
                {" "}
                — <span className="muted">
                  revoked{" "}
                  {new Date(basisPolicy.revokedAt).toLocaleString()}
                </span>
              </>
            ) : null}
          </p>
        ) : (
          <p className="muted">
            Basis policy no longer available (cascade-deleted).
          </p>
        )}
      </section>

      <section>
        <h4>
          Basis approvals ({basisApprovals.length} of{" "}
          {lineage.basisApprovalIds.length})
        </h4>
        {basisApprovals.length === 0 ? (
          <p className="muted">
            All basis approvals have been cascade-deleted. Ids:{" "}
            <span className="mono">
              {lineage.basisApprovalIds.join(", ")}
            </span>
          </p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Resolved</th>
                <th>Subject</th>
                <th>Summary</th>
                <th>State</th>
                <th>By</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {basisApprovals.map((a) => (
                <tr key={a.id}>
                  <td className="mono">
                    {a.resolvedAt
                      ? new Date(a.resolvedAt).toLocaleString()
                      : "—"}
                  </td>
                  <td className="mono">{a.subjectPrincipalId ?? "—"}</td>
                  <td>{a.summary}</td>
                  <td>
                    <span
                      className={`tag ${
                        a.state === "approved" ? "confirmed" : ""
                      }`}
                    >
                      {a.state}
                    </span>
                  </td>
                  <td className="mono">
                    {a.resolvedByType ? `${a.resolvedByType}:${a.resolvedById?.slice(0, 8) ?? ""}` : "—"}
                  </td>
                  <td className="mono">
                    {a.amountUsd !== null ? `$${a.amountUsd.toFixed(2)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
