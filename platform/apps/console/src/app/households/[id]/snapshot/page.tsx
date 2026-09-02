import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionToken } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import type { HouseholdId } from "@atelier/domain";
import { ConsoleNav } from "../../../console-nav";

// Household health snapshot — a single-page summary meant to be
// shared with a customer as "here's what's happening across your
// household right now". Deliberately spartan and screenshot-safe:
// counts, top-3 lists, chain-valid checkmark, no ids or raw ask
// summaries that would leak sensitive detail.

export default async function HouseholdSnapshotPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) redirect("/");

  const client = api(token);
  const [{ actor }, snapshotRes] = await Promise.all([
    client.me(),
    client.householdSnapshot(id as HouseholdId).catch((e) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403))
        return null;
      throw e;
    }),
  ]);

  if (!snapshotRes) notFound();
  const s = snapshotRes.snapshot;

  return (
    <>
      <ConsoleNav managerName={actor.displayName} />
      <main className="page snapshot">
        <p className="eyebrow">
          <Link href={`/households/${id}`}>{s.household.name}</Link> · snapshot
        </p>
        <h1 className="display">{s.household.name}</h1>
        <p className="subtitle">
          {s.household.tier} household · generated{" "}
          {new Date(s.generatedAt).toLocaleString()}
          {s.lastActivityAt ? (
            <>
              {" "}
              · last activity{" "}
              {new Date(s.lastActivityAt).toLocaleString()}
            </>
          ) : null}
        </p>

        {s.household.frozen ? (
          <div
            className="empty"
            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
          >
            <strong>Frozen</strong>
            {s.household.frozenReason ? ` — ${s.household.frozenReason}` : ""}.
            Every agent action is shelved until this is lifted.
          </div>
        ) : null}

        <div className="snapshot-grid">
          <SnapshotTile
            label="Audit chain"
            value={
              s.auditChain.valid ? (
                <span style={{ color: "var(--success, #166534)" }}>
                  ✓ verified
                </span>
              ) : (
                <span style={{ color: "var(--danger)" }}>
                  ✗ broken at {s.auditChain.brokenAtEventId?.slice(0, 10)}…
                </span>
              )
            }
            hint={`${s.auditChain.eventCount} events${
              s.auditChain.headAt
                ? ` · last ${new Date(s.auditChain.headAt).toLocaleString()}`
                : ""
            }`}
          />
          <SnapshotTile
            label="Pending approvals"
            value={<span className="mono">{s.approvals.pending}</span>}
            hint={
              s.approvals.overdue > 0
                ? `${s.approvals.overdue} overdue`
                : s.approvals.staleWithinDay > 0
                  ? `${s.approvals.staleWithinDay} due within 24h`
                  : "queue clear"
            }
            {...(s.approvals.overdue > 0
              ? { tone: "danger" as const }
              : s.approvals.staleWithinDay > 0
                ? { tone: "warn" as const }
                : {})}
          />
          <SnapshotTile
            label="Actions this week"
            value={<span className="mono">{s.weekActivity.totalActions}</span>}
            hint={
              Object.entries(s.weekActivity.byOutcome)
                .map(([k, v]) => `${v} ${k}`)
                .join(" · ") || "no actions yet"
            }
          />
          <SnapshotTile
            label="Unread threads (24h)"
            value={<span className="mono">{s.messaging.unreadThreads}</span>}
            hint={
              s.messaging.deliveryFailuresLast24h > 0
                ? `${s.messaging.deliveryFailuresLast24h} delivery failure${s.messaging.deliveryFailuresLast24h === 1 ? "" : "s"}`
                : "all delivered"
            }
            {...(s.messaging.deliveryFailuresLast24h > 0
              ? { tone: "warn" as const }
              : {})}
          />
          <SnapshotTile
            label="Upcoming obligations (14d)"
            value={<span className="mono">{s.obligations.upcoming14d}</span>}
            hint={
              s.obligations.top[0]
                ? `next: ${s.obligations.top[0].title} in ${s.obligations.top[0].daysLeft}d`
                : "nothing on deck"
            }
          />
          <SnapshotTile
            label="Active policies"
            value={<span className="mono">{s.policies.totalActive}</span>}
            hint={`${s.policies.executeCount} auto-executing`}
          />
        </div>

        <section className="snapshot-section">
          <h2>Autonomy settings</h2>
          <p>
            Autopilot{" "}
            <StatusTag on={s.household.autopilotEnabled} labelOn="on" labelOff="paused" />
            {" · "}
            Instant ack{" "}
            <StatusTag
              on={s.household.instantAckEnabled}
              labelOn="on"
              labelOff="off"
            />
            {" · "}
            Agent-authored sends{" "}
            <StatusTag
              on={s.household.agentSendingEnabled}
              labelOn="allowed"
              labelOff="blocked"
            />
          </p>
        </section>

        <section className="snapshot-section">
          <h2>Top action classes this week</h2>
          {s.weekActivity.topActionClasses.length === 0 ? (
            <p className="muted">No actions this week.</p>
          ) : (
            <ol className="snapshot-top-list">
              {s.weekActivity.topActionClasses.map((c) => (
                <li key={c.actionClass}>
                  <span className="mono">{c.actionClass}</span> —{" "}
                  <span className="mono">{c.count}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="snapshot-section">
          <h2>Top policies exercised this week</h2>
          {s.weekActivity.topPolicies.length === 0 ? (
            <p className="muted">No policy-authorised actions this week.</p>
          ) : (
            <ol className="snapshot-top-list">
              {s.weekActivity.topPolicies.map((p) => (
                <li key={p.policyId}>
                  {p.label} — <span className="mono">{p.count}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {s.obligations.top.length > 0 ? (
          <section className="snapshot-section">
            <h2>Upcoming obligations</h2>
            <ol className="snapshot-top-list">
              {s.obligations.top.map((o) => (
                <li key={`${o.title}::${o.dueAt}`}>
                  {o.title} — due in{" "}
                  <span className="mono">{o.daysLeft}d</span> (
                  <span className="mono">
                    {new Date(o.dueAt).toLocaleDateString()}
                  </span>
                  )
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </main>
    </>
  );
}

function SnapshotTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint: string;
  tone?: "warn" | "danger";
}) {
  return (
    <div className={`snapshot-tile ${tone ? `snapshot-tile-${tone}` : ""}`}>
      <div className="snapshot-tile-label">{label}</div>
      <div className="snapshot-tile-value">{value}</div>
      <div className="snapshot-tile-hint muted">{hint}</div>
    </div>
  );
}

function StatusTag({
  on,
  labelOn,
  labelOff,
}: {
  on: boolean;
  labelOn: string;
  labelOff: string;
}) {
  return (
    <span className={`tag ${on ? "confirmed" : ""}`}>
      {on ? labelOn : labelOff}
    </span>
  );
}
