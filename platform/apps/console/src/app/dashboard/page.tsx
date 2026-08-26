import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionToken } from "@/lib/session";
import { api } from "@/lib/api";
import { ConsoleNav } from "../console-nav";
import { ApprovalCard } from "../approvals/approval-card";

export default async function Dashboard() {
  const token = await getSessionToken();
  if (!token) redirect("/");

  const client = api(token);
  const [{ actor }, { households }, { approvals }, attention] = await Promise.all([
    client.me(),
    client.listHouseholds(),
    client.approvalInbox().catch(() => ({ approvals: [] })),
    client.attention().catch(() => ({
      generatedAt: new Date().toISOString(),
      items: [],
      counts: {
        deliveryFailures: 0,
        unreadThreads: 0,
        upcomingObligations: 0,
        frozenHouseholds: 0,
      },
    })),
  ]);

  const householdName = new Map(households.map((h) => [h.id, h.name] as const));

  return (
    <>
      <ConsoleNav managerName={actor.displayName} />
      <main className="page">
        <p className="eyebrow">Manager Inbox</p>
        <h1 className="display">
          {approvals.length === 0
            ? `Nothing needs your judgment, ${firstName(actor.displayName)}.`
            : `${approvals.length} decision${approvals.length === 1 ? "" : "s"} waiting.`}
        </h1>
        <p className="subtitle">
          {households.length} household{households.length === 1 ? "" : "s"} under your care.
        </p>

        {approvals.length > 0 ? (
          <div className="approvals-stack">
            {approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                householdName={householdName.get(a.householdId) ?? "Unknown"}
              />
            ))}
          </div>
        ) : null}

        {attention.items.length > 0 ? (
          <section className="attention-section">
            <div className="section-head">
              <h2>Attention</h2>
              <span className="mono">{attention.items.length}</span>
            </div>
            <p className="attention-summary muted">
              {[
                attention.counts.deliveryFailures > 0
                  ? `${attention.counts.deliveryFailures} delivery failure${attention.counts.deliveryFailures === 1 ? "" : "s"}`
                  : null,
                attention.counts.frozenHouseholds > 0
                  ? `${attention.counts.frozenHouseholds} frozen household${attention.counts.frozenHouseholds === 1 ? "" : "s"}`
                  : null,
                attention.counts.unreadThreads > 0
                  ? `${attention.counts.unreadThreads} unread thread${attention.counts.unreadThreads === 1 ? "" : "s"}`
                  : null,
                attention.counts.upcomingObligations > 0
                  ? `${attention.counts.upcomingObligations} upcoming obligation${attention.counts.upcomingObligations === 1 ? "" : "s"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="attention-stack">
              {attention.items.map((item, i) => (
                <Link
                  key={`${item.kind}-${item.householdId}-${item.sortAt}-${i}`}
                  href={`/households/${item.householdId}`}
                  className={`attention-card attention-${item.kind}`}
                >
                  <div className="attention-head">
                    <span className={`tag attention-tag-${item.kind}`}>
                      {attentionLabel(item.kind)}
                    </span>
                    <span className="attention-household">{item.householdName}</span>
                    <span className="mono muted">
                      {new Date(item.sortAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="attention-body">{item.summary}</p>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        <div className="section-head">
          <h2>Households</h2>
          <span className="mono">{households.length}</span>
        </div>
        {households.length === 0 ? (
          <div className="empty">
            No households granted to this manager yet. Run the seed script or grant this
            manager to a household from the API.
          </div>
        ) : (
          <div className="grid-cards">
            {households.map((h) => (
              <Link
                key={h.id}
                href={`/households/${h.id}`}
                className="card household-card"
              >
                <p className="name">{h.name}</p>
                <div className="meta">
                  <span className={`tag tier-${h.tier}`}>{h.tier}</span>
                  <span>Since {new Date(h.createdAt).toLocaleDateString()}</span>
                  {h.frozenAt ? <span className="tag retired">frozen</span> : null}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function firstName(full: string): string {
  return full.split(" ")[0] ?? full;
}

function attentionLabel(
  kind:
    | "delivery_failure"
    | "unread_thread"
    | "upcoming_obligation"
    | "frozen_household",
): string {
  switch (kind) {
    case "delivery_failure":
      return "delivery failed";
    case "unread_thread":
      return "unread";
    case "upcoming_obligation":
      return "upcoming";
    case "frozen_household":
      return "frozen";
  }
}
