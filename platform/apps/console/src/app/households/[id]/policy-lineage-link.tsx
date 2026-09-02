"use client";

import { useState, useTransition } from "react";
import { loadPolicyLineage, type PolicyLineage } from "./actions";
import type { HouseholdId } from "@atelier/domain";

// One modal, two entry points:
//   - <PolicyLineageLink>: renders as a promote/demote tag on the
//     Policies table's Origin cell; suggestion-adopted policies
//     only.
//   - <PolicyAuthorityLink>: renders as a mono-styled short id on
//     the Recent actions table's Authority cell; opens the SAME
//     modal so an auditor can walk from action → authorizing
//     policy → (if adopted) the basis approvals in one click
//     through.
// Fetching is lazy — most rows on the page won't ever be
// inspected — and memoised per component instance so re-opening
// doesn't refetch.

function usePolicyModal(householdId: HouseholdId, policyId: string) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PolicyLineage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const trigger = () => {
    setOpen(true);
    if (data !== null) return;
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

  const modal = open ? (
    <div className="modal-scrim" onClick={() => setOpen(false)}>
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <h3>{data?.lineage ? "Policy lineage" : "Policy details"}</h3>
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
  ) : null;

  return { trigger, modal };
}

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
  const { trigger, modal } = usePolicyModal(householdId, policyId);
  const label =
    kind === "promote"
      ? `↑ from ${approvalCount} approval${approvalCount === 1 ? "" : "s"}`
      : `↓ from override pattern`;
  return (
    <>
      <button type="button" className="tag confirmed lineage-tag" onClick={trigger}>
        {label}
      </button>
      {modal}
    </>
  );
}

// Reverse-audit entry point — the Recent actions table's Authority
// cell links here. Opens the same modal so the reader can walk
// "this action ran under policy X, which was itself auto-promoted
// from these 5 approvals" without ever touching a raw id.
export function PolicyAuthorityLink({
  householdId,
  policyId,
}: {
  householdId: HouseholdId;
  policyId: string;
}) {
  const { trigger, modal } = usePolicyModal(householdId, policyId);
  const short = policyId.length > 12 ? `${policyId.slice(0, 8)}…` : policyId;
  return (
    <>
      <button type="button" className="mono lineage-authority-link" onClick={trigger}>
        {short}
      </button>
      {modal}
    </>
  );
}

function LineageBody({ data }: { data: PolicyLineage }) {
  const { policy, lineage, basisPolicy, basisApprovals } = data;
  return (
    <div className="lineage-body">
      <section>
        <h4>Policy</h4>
        <p>
          <strong>{policy.label}</strong> —{" "}
          <span className="mono">
            {policy.domain}::{policy.actionClass}
          </span>{" "}
          on <span className="mono">{policy.subject}</span> at rung{" "}
          <span className="tag">{policy.autonomy}</span>{" "}
          <span className="mono">({policy.effect})</span>
        </p>
        <p className="muted">
          Created {new Date(policy.createdAt).toLocaleString()}
          {policy.revokedAt ? (
            <>
              {" "}
              — <span className="error">
                revoked {new Date(policy.revokedAt).toLocaleString()}
              </span>
            </>
          ) : null}
        </p>
      </section>

      {lineage ? (
        <>
          <section>
            <h4>Origin</h4>
            <p>
              Adopted from a <strong>{lineage.kind}</strong> suggestion at{" "}
              {new Date(lineage.suggestedAt).toLocaleString()}. Ids:{" "}
              <span className="mono">{lineage.basisApprovalIds.length}</span>{" "}
              basis approval
              {lineage.basisApprovalIds.length === 1 ? "" : "s"}.
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
                        {a.resolvedByType
                          ? `${a.resolvedByType}:${a.resolvedById?.slice(0, 8) ?? ""}`
                          : "—"}
                      </td>
                      <td className="mono">
                        {a.amountUsd !== null
                          ? `$${a.amountUsd.toFixed(2)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : (
        <section>
          <h4>Origin</h4>
          <p className="muted">
            Hand-written policy — created directly by the manager, not
            adopted from an autonomy-ladder suggestion. Nothing further to
            drill into.
          </p>
        </section>
      )}
    </div>
  );
}
