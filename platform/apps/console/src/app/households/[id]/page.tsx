import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionToken } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import type { HouseholdId } from "@atelier/domain";
import { ConsoleNav } from "../../console-nav";

export default async function HouseholdPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) redirect("/");

  const client = api(token);
  const [{ actor }, hh, { nodes }, { events }] = await Promise.all([
    client.me(),
    client
      .getHousehold(id as HouseholdId)
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
        throw e;
      }),
    client
      .listNodes(id as HouseholdId)
      .catch(() => ({ nodes: [] as Awaited<ReturnType<typeof client.listNodes>>["nodes"] })),
    client
      .listAudit(id as HouseholdId)
      .catch(() => ({ events: [] as Awaited<ReturnType<typeof client.listAudit>>["events"] })),
  ]);

  if (!hh) notFound();

  const nodesByType = groupBy(nodes, (n) => n.type);

  return (
    <>
      <ConsoleNav managerName={actor.displayName} />
      <main className="page">
        <p className="eyebrow">
          <Link href="/dashboard">Households</Link> · {hh.household.tier}
        </p>
        <h1 className="display">{hh.household.name}</h1>
        <p className="subtitle">
          Household since {new Date(hh.household.createdAt).toLocaleDateString()} ·{" "}
          {nodes.length} node{nodes.length === 1 ? "" : "s"} in the graph
        </p>

        <div className="section-head">
          <h2>Graph</h2>
          <span className="mono">{nodes.length} nodes</span>
        </div>
        {nodes.length === 0 ? (
          <div className="empty">Graph is empty. Seed some entities via the API.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th>Summary</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Asserted</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(nodesByType.entries()).flatMap(([type, group]) =>
                group.map((n) => (
                  <tr key={n.id}>
                    <td className="mono">{type}</td>
                    <td>{summarize(n.data)}</td>
                    <td>
                      <span className={`tag ${n.provenance.status}`}>
                        {n.provenance.status}
                      </span>
                    </td>
                    <td className="mono">{n.provenance.confidence.toFixed(2)}</td>
                    <td className="mono">
                      {new Date(n.provenance.assertedAt).toLocaleString()}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}

        <div className="section-head">
          <h2>Audit trail</h2>
          <span className="mono">most recent {events.length}</span>
        </div>
        {events.length === 0 ? (
          <div className="empty">No audit events yet.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{new Date(e.at).toLocaleString()}</td>
                  <td className="mono">
                    {e.actorType}:{shortId(e.actorId)}
                  </td>
                  <td>{e.action}</td>
                  <td className="mono">
                    {e.resourceType}:{shortId(e.resourceId)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}

function summarize(data: unknown): string {
  if (data === null || typeof data !== "object") return String(data);
  const d = data as Record<string, unknown>;
  for (const key of ["fullName", "title", "label", "name", "summary"]) {
    const v = d[key];
    if (typeof v === "string") return v;
  }
  return Object.keys(d).slice(0, 3).join(", ");
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = m.get(k);
    if (existing) existing.push(item);
    else m.set(k, [item]);
  }
  return m;
}
