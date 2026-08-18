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
  const [{ actor }, { households }, { approvals }] = await Promise.all([
    client.me(),
    client.listHouseholds(),
    client.approvalInbox().catch(() => ({ approvals: [] })),
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
