import type { HouseholdId } from "@atelier/domain";
import type { TaskSummary } from "@/lib/api";
import { TaskObservability } from "./task-observability";

// Recent tasks used to be a flat table; this component renders each
// task with a per-kind body. Everything below the row header is a
// projection over the outputs blob, keyed off task.kind.
//
// Adding a new agent means adding a new case here (or falling through
// to the JSON pretty-print, which stays as the debug default).

const state = (s: string): string => {
  if (s === "completed") return "confirmed";
  if (s === "escalated") return "candidate";
  if (s === "failed" || s === "rejected" || s === "shelved") return "retired";
  return "candidate";
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function TaskCard({
  task,
  householdId,
}: {
  task: TaskSummary;
  householdId: HouseholdId;
}) {
  const outputs = isRecord(task.outputs) ? task.outputs : null;

  return (
    <article className="card task-card">
      <header className="task-head">
        <div>
          <p className="task-meta">
            <span className="mono">{task.agent}@{task.agentVersion}</span>
            <span className="mono">{task.kind}</span>
            <span className="mono">{new Date(task.createdAt).toLocaleString()}</span>
          </p>
          {task.decisionSummary ? (
            <p className="task-summary">{task.decisionSummary}</p>
          ) : task.errorMessage ? (
            <p className="task-summary error">{task.errorMessage}</p>
          ) : null}
        </div>
        <span className={`tag ${state(task.state)}`}>{task.state}</span>
      </header>

      {outputs ? <TaskBody kind={task.kind} outputs={outputs} /> : null}

      <TaskObservability
        householdId={householdId}
        taskId={task.id}
        runId={task.runId}
      />
    </article>
  );
}

function TaskBody({
  kind,
  outputs,
}: {
  kind: string;
  outputs: Record<string, unknown>;
}) {
  if (kind === "research.query") return <ResearchBody outputs={outputs} />;
  if (kind === "admin.renewals.review") return <AdminBody outputs={outputs} />;
  if (kind === "family.coverage.propose") return <FamilyCoverageBody outputs={outputs} />;
  if (kind === "family.school.form_due") return <SchoolFormBody outputs={outputs} />;
  if (kind === "inbox.message.process") return <InboxBody outputs={outputs} />;
  if (kind.startsWith("calendar.appointment")) return <CalendarBody outputs={outputs} />;
  if (kind.startsWith("household.vendor")) return <VendorBody outputs={outputs} />;
  if (kind === "travel.trip.plan") return <TravelTripBody outputs={outputs} />;
  if (kind === "travel.flight.search") return <TravelFlightBody outputs={outputs} />;

  return <RawOutputs outputs={outputs} />;
}

function RawOutputs({ outputs }: { outputs: Record<string, unknown> }) {
  return (
    <details className="task-details">
      <summary>Outputs</summary>
      <pre className="mono">{JSON.stringify(outputs, null, 2)}</pre>
    </details>
  );
}

function ResearchBody({ outputs }: { outputs: Record<string, unknown> }) {
  const summary = String(outputs["summary"] ?? "");
  const question = String(outputs["question"] ?? "");
  const turns = Number(outputs["turns"] ?? 0);
  const cost = Number(outputs["totalCostUsdEstimated"] ?? 0);
  const trace = Array.isArray(outputs["toolTrace"])
    ? (outputs["toolTrace"] as Array<{ name: string; summary: string }>)
    : [];
  return (
    <>
      {question ? (
        <p className="task-eyebrow">
          Question · <span className="mono">{question}</span>
        </p>
      ) : null}
      {summary ? <p className="task-prose">{summary}</p> : null}
      <p className="task-meta">
        <span className="mono">
          {turns} turn{turns === 1 ? "" : "s"}
        </span>
        <span className="mono">{trace.length} tool call{trace.length === 1 ? "" : "s"}</span>
        <span className="mono">${cost.toFixed(4)}</span>
      </p>
      {trace.length > 0 ? (
        <details className="task-details">
          <summary>Tool trace</summary>
          <ul className="trace-list">
            {trace.map((t, i) => (
              <li key={i}>
                <span className="tag">{t.name}</span> {t.summary}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function AdminBody({ outputs }: { outputs: Record<string, unknown> }) {
  const expiring = Array.isArray(outputs["expiring"])
    ? (outputs["expiring"] as Array<{
        id: string;
        title: string;
        type: string;
        expiresAt: string;
        daysUntilExpiry: number;
        urgency: string;
        recommendedAction: string;
      }>)
    : [];
  const windowDays = Number(outputs["windowDays"] ?? 0);
  return (
    <>
      <p className="task-meta">
        <span className="mono">
          window · {windowDays}d
        </span>
        <span className="mono">
          {expiring.length} item{expiring.length === 1 ? "" : "s"}
        </span>
      </p>
      {expiring.length === 0 ? (
        <p className="task-prose">Nothing due in the window.</p>
      ) : (
        <table className="data inline-data">
          <thead>
            <tr>
              <th>Document</th>
              <th>Expires</th>
              <th>Urgency</th>
              <th>Recommended</th>
            </tr>
          </thead>
          <tbody>
            {expiring.map((e) => (
              <tr key={e.id}>
                <td>{e.title}<div className="mono muted">{e.type}</div></td>
                <td className="mono">
                  {new Date(e.expiresAt).toLocaleDateString()}
                  <div className="mono muted">in {e.daysUntilExpiry}d</div>
                </td>
                <td>
                  <span
                    className={`tag ${
                      e.urgency === "high"
                        ? "retired"
                        : e.urgency === "normal"
                          ? "candidate"
                          : "confirmed"
                    }`}
                  >
                    {e.urgency}
                  </span>
                </td>
                <td>{e.recommendedAction}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function FamilyCoverageBody({ outputs }: { outputs: Record<string, unknown> }) {
  const plan = isRecord(outputs["plan"]) ? outputs["plan"] : null;
  const summary = plan ? String(plan["summary"] ?? "") : "";
  const assignments =
    plan && Array.isArray(plan["assignments"])
      ? (plan["assignments"] as Array<{
          personName: string;
          routine: string;
          note?: string;
        }>)
      : [];
  const openQs =
    plan && Array.isArray(plan["openQuestions"])
      ? (plan["openQuestions"] as string[])
      : [];
  const window = isRecord(outputs["window"]) ? outputs["window"] : null;

  return (
    <>
      {window ? (
        <p className="task-meta">
          <span className="mono">
            {String(window["startAt"])} → {String(window["endAt"])}
          </span>
        </p>
      ) : null}
      {summary ? <p className="task-prose">{summary}</p> : null}
      {assignments.length > 0 ? (
        <table className="data inline-data">
          <thead>
            <tr>
              <th>Routine</th>
              <th>Person</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a, i) => (
              <tr key={i}>
                <td>{a.routine}</td>
                <td className="mono">{a.personName}</td>
                <td>{a.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {openQs.length > 0 ? (
        <ul className="open-questions">
          {openQs.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function SchoolFormBody({ outputs }: { outputs: Record<string, unknown> }) {
  const formTitle = String(outputs["formTitle"] ?? "");
  const memberName = String(outputs["memberName"] ?? "");
  const dueAt = String(outputs["dueAt"] ?? "");
  return (
    <p className="task-prose">
      Queued <strong>{formTitle}</strong> for {memberName}, due{" "}
      {dueAt ? new Date(dueAt).toLocaleDateString() : "TBD"}.
    </p>
  );
}

function InboxBody({ outputs }: { outputs: Record<string, unknown> }) {
  const draft = typeof outputs["draft"] === "string" ? String(outputs["draft"]) : "";
  const triage = isRecord(outputs["triage"]) ? outputs["triage"] : null;
  const extractedIds =
    Array.isArray(outputs["extractedObligationIds"])
      ? (outputs["extractedObligationIds"] as string[])
      : [];
  const approvalId =
    typeof outputs["approvalId"] === "string" ? String(outputs["approvalId"]) : "";

  return (
    <>
      {triage ? (
        <p className="task-meta">
          <span className="tag">{String(triage["urgency"] ?? "?")}</span>
          <span className="mono">{String(triage["recipientClass"] ?? "?")}</span>
          <span className="mono">
            reply · {String(triage["requiresReply"] ?? "?")}
          </span>
        </p>
      ) : null}
      {extractedIds.length > 0 ? (
        <p className="task-meta">
          <span className="mono">
            {extractedIds.length} obligation{extractedIds.length === 1 ? "" : "s"} extracted
          </span>
        </p>
      ) : null}
      {draft ? (
        <>
          <p className="task-eyebrow">Drafted reply</p>
          <p className="task-prose">{draft}</p>
        </>
      ) : null}
      {approvalId ? (
        <p className="task-meta">
          <span className="mono muted">approval: {approvalId}</span>
        </p>
      ) : null}
    </>
  );
}

function CalendarBody({ outputs }: { outputs: Record<string, unknown> }) {
  const appt = isRecord(outputs["appointment"]) ? outputs["appointment"] : null;
  const conflicts = Array.isArray(outputs["conflicts"])
    ? (outputs["conflicts"] as Array<{ id: string; title: string; startAt: string }>)
    : null;
  if (conflicts && conflicts.length > 0) {
    return (
      <>
        <p className="task-eyebrow">Conflicts</p>
        <ul className="open-questions">
          {conflicts.map((c) => (
            <li key={c.id}>
              {c.title} — {new Date(c.startAt).toLocaleString()}
            </li>
          ))}
        </ul>
      </>
    );
  }
  if (!appt) return null;
  const startAt = String(appt["startAt"] ?? "");
  const endAt = appt["endAt"] ? String(appt["endAt"]) : "";
  const supersedes = appt["supersedes"] ? String(appt["supersedes"]) : "";
  return (
    <p className="task-prose">
      {startAt ? new Date(startAt).toLocaleString() : "TBD"}
      {endAt ? ` → ${new Date(endAt).toLocaleTimeString()}` : ""}
      {supersedes ? ` (supersedes ${supersedes.slice(0, 8)}…)` : ""}
    </p>
  );
}

function TravelTripBody({ outputs }: { outputs: Record<string, unknown> }) {
  const dest = String(outputs["destination"] ?? "");
  const dates = isRecord(outputs["dates"]) ? outputs["dates"] : null;
  const travelers = Array.isArray(outputs["travelers"])
    ? (outputs["travelers"] as Array<{ id: string; name: string; type: string }>)
    : [];
  const plan = isRecord(outputs["plan"]) ? outputs["plan"] : null;
  const flights =
    plan && Array.isArray(plan["flights"])
      ? (plan["flights"] as Array<{
          direction?: string;
          note?: string;
          price?: number;
          refundable?: boolean;
          loyaltyMatch?: boolean;
        }>)
      : [];
  const hotels =
    plan && Array.isArray(plan["hotels"])
      ? (plan["hotels"] as Array<{
          name?: string;
          area?: string;
          nightly?: number;
          note?: string;
          loyaltyMatch?: boolean;
        }>)
      : [];
  const ground = plan ? String(plan["groundTransportation"] ?? "") : "";
  const documentNotes =
    plan && Array.isArray(plan["documentNotes"])
      ? (plan["documentNotes"] as string[])
      : [];
  const coord = plan && isRecord(plan["coordinationNeeds"]) ? plan["coordinationNeeds"] : null;
  const openQs =
    plan && Array.isArray(plan["openQuestions"])
      ? (plan["openQuestions"] as string[])
      : [];

  return (
    <>
      <p className="task-meta">
        <span className="mono">
          {dest}
          {dates
            ? ` · ${String(dates["startAt"]).slice(0, 10)} → ${String(dates["endAt"]).slice(0, 10)}`
            : ""}
        </span>
        {travelers.length > 0 ? (
          <span className="mono">
            {travelers.length} traveler{travelers.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </p>

      {flights.length > 0 ? (
        <>
          <p className="task-eyebrow">Flights</p>
          <table className="data inline-data">
            <thead>
              <tr>
                <th>Direction</th>
                <th>Note</th>
                <th>Price</th>
                <th>Refundable</th>
                <th>Loyalty</th>
              </tr>
            </thead>
            <tbody>
              {flights.map((f, i) => (
                <tr key={i}>
                  <td className="mono">{f.direction ?? ""}</td>
                  <td>{f.note ?? ""}</td>
                  <td className="mono">
                    {typeof f.price === "number" ? `$${f.price.toFixed(0)}` : ""}
                  </td>
                  <td className="mono">{f.refundable ? "yes" : "no"}</td>
                  <td className="mono">{f.loyaltyMatch ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {hotels.length > 0 ? (
        <>
          <p className="task-eyebrow">Hotels</p>
          <table className="data inline-data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Area</th>
                <th>Nightly</th>
                <th>Loyalty</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {hotels.map((h, i) => (
                <tr key={i}>
                  <td>{h.name ?? ""}</td>
                  <td className="mono">{h.area ?? ""}</td>
                  <td className="mono">
                    {typeof h.nightly === "number" ? `$${h.nightly.toFixed(0)}` : ""}
                  </td>
                  <td className="mono">{h.loyaltyMatch ? "yes" : "no"}</td>
                  <td>{h.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {ground ? (
        <>
          <p className="task-eyebrow">Ground</p>
          <p className="task-prose">{ground}</p>
        </>
      ) : null}

      {documentNotes.length > 0 ? (
        <>
          <p className="task-eyebrow">Documents</p>
          <ul className="open-questions">
            {documentNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      ) : null}

      {coord ? (
        <>
          <p className="task-eyebrow">Coordination</p>
          <table className="data inline-data">
            <tbody>
              {Object.entries(coord).map(([domain, note]) => (
                <tr key={domain}>
                  <td className="mono" style={{ width: 120 }}>
                    {domain}
                  </td>
                  <td>{String(note)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {openQs.length > 0 ? (
        <>
          <p className="task-eyebrow">Open questions</p>
          <ul className="open-questions">
            {openQs.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function TravelFlightBody({ outputs }: { outputs: Record<string, unknown> }) {
  const candidates = Array.isArray(outputs["candidates"])
    ? (outputs["candidates"] as Array<{
        airline?: string;
        cabin?: string;
        price?: number;
        refundable?: boolean;
        loyaltyMatch?: boolean;
        note?: string;
      }>)
    : [];
  if (candidates.length === 0) return null;
  return (
    <table className="data inline-data">
      <thead>
        <tr>
          <th>Airline</th>
          <th>Cabin</th>
          <th>Price</th>
          <th>Refundable</th>
          <th>Loyalty</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c, i) => (
          <tr key={i}>
            <td>{c.airline ?? ""}</td>
            <td className="mono">{c.cabin ?? ""}</td>
            <td className="mono">
              {typeof c.price === "number" ? `$${c.price.toFixed(0)}` : ""}
            </td>
            <td className="mono">{c.refundable ? "yes" : "no"}</td>
            <td className="mono">{c.loyaltyMatch ? "yes" : "no"}</td>
            <td>{c.note ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VendorBody({ outputs }: { outputs: Record<string, unknown> }) {
  const vendor = isRecord(outputs["vendor"]) ? outputs["vendor"] : null;
  const booking = isRecord(outputs["booking"]) ? outputs["booking"] : null;
  const purchase = isRecord(outputs["purchase"]) ? outputs["purchase"] : null;
  if (!vendor) return null;
  return (
    <p className="task-prose">
      Vendor: <strong>{String(vendor["name"])}</strong>
      {booking ? ` · booking ${String(booking["bookingRef"])}` : ""}
      {purchase ? ` · receipt ${String(purchase["receiptRef"])}` : ""}
    </p>
  );
}
