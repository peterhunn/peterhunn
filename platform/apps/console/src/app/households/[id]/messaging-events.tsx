interface MessagingEvent {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  provider: string;
  fromAddress: string;
  toAddress: string;
  body: string;
  receivedAt: string;
  plannerRunId: string | null;
}

export function MessagingEvents({ events }: { events: MessagingEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div>
      <div className="section-head">
        <h2>Recent messages</h2>
        <span className="mono">{events.length}</span>
      </div>
      <ul className="messaging-events">
        {events.map((e) => (
          <li key={e.id} className={`messaging-event dir-${e.direction}`}>
            <div className="messaging-meta">
              <span className={`tag tag-${e.channel}`}>{e.channel}</span>
              <span className="tag">{e.direction}</span>
              <span className="muted">{e.provider}</span>
              <span className="mono">{new Date(e.receivedAt).toLocaleString()}</span>
              {e.plannerRunId ? (
                <span className="mono muted">run {e.plannerRunId.slice(0, 10)}</span>
              ) : null}
            </div>
            <div className="messaging-addresses">
              <span className="mono">{e.fromAddress}</span>
              <span className="muted">→</span>
              <span className="mono">{e.toAddress}</span>
            </div>
            <p className="messaging-body">{e.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
