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
  const [{ actor }, hhRes, nodesRes, eventsRes, policiesRes, actionsRes] = await Promise.all([
    client.me(),
    client
      .getHousehold(id as HouseholdId)
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
        throw e;
      }),
    client.listNodes(id as HouseholdId).catch(() => ({ nodes: [] })),
    client.listAudit(id as HouseholdId).catch(() => ({ events: [] })),
    client.listPolicies(id as HouseholdId).catch(() => ({ policies: [] })),
    client.listActions(id as HouseholdId).catch(() => ({ actions: [] })),
  ]);

  if (!hhRes) notFound();
  const hh = hhRes.household;
  const nodes = nodesRes.nodes;
  const events = eventsRes.events;
  const policies = policiesRes.policies;
  const actions = actionsRes.actions;

  return (
    <>
      <ConsoleNav managerName={actor.displayName} />
      <main className="page">
        <p className="eyebrow">
          <Link href="/dashboard">Households</Link> · {hh.tier}
        </p>
        <h1 className="display">{hh.name}</h1>
        <p className="subtitle">
          Since {new Date(hh.createdAt).toLocaleDateString()} · {nodes.length} node
          {nodes.length === 1 ? "" : "s"} · {policies.length} polic
          {policies.length === 1 ? "y" : "ies"} · {actions.length} action
          {actions.length === 1 ? "" : "s"}
        </p>

        {hh.frozenAt ? (
          <div className="empty" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
            Household is <strong>frozen</strong>
            {hh.frozenReason ? ` — ${hh.frozenReason}` : ""}. Everything is in Observe.
          </div>
        ) : null}

        <div className="section-head">
          <h2>Policies</h2>
          <span className="mono">{policies.length} active</span>
        </div>
        {policies.length === 0 ? (
          <div className="empty">No policies yet. Every action will be denied.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Label</th>
                <th>Domain</th>
                <th>Action class</th>
                <th>Rung</th>
                <th>Effect</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>{p.spec.label}</td>
                  <td className="mono">{p.spec.domain}</td>
                  <td className="mono">{p.spec.actionClass}</td>
                  <td>
                    <span className="tag">{p.spec.autonomy}</span>
                  </td>
                  <td className="mono">{p.spec.effect}</td>
                  <td className="mono">{p.spec.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="section-head">
          <h2>Recent actions</h2>
          <span className="mono">last {actions.length}</span>
        </div>
        {actions.length === 0 ? (
          <div className="empty">No actions recorded yet.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Class</th>
                <th>Summary</th>
                <th>Outcome</th>
                <th>Amount</th>
                <th>Authority</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="mono">{a.actionClass}</td>
                  <td>{a.summary}</td>
                  <td>
                    <span className={`tag ${a.outcome === "succeeded" ? "confirmed" : "candidate"}`}>
                      {a.outcome}
                    </span>
                  </td>
                  <td className="mono">
                    {a.amountUsd !== null ? `$${a.amountUsd.toFixed(2)}` : "—"}
                  </td>
                  <td className="mono">
                    {a.policyIdAuthorizing ? shortId(a.policyIdAuthorizing) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="section-head">
          <h2>Graph</h2>
          <span className="mono">{nodes.length} nodes</span>
        </div>
        {nodes.length === 0 ? (
          <div className="empty">Graph is empty.</div>
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
              {nodes.map((n) => (
                <tr key={n.id}>
                  <td className="mono">{n.type}</td>
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
              ))}
            </tbody>
          </table>
        )}

        <div className="section-head">
          <h2>Audit trail</h2>
          <span className="mono">last {events.length}</span>
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
