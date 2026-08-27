"use client";

import { useState, useTransition } from "react";
import type { HouseholdId } from "@atelier/domain";
import type { Person } from "./invite-customer";
import { loadCustomerActivity, type CustomerActivityResponse } from "./actions";

// Per-customer unified activity — SMS + email interleaved by
// receivedAt for one principal at a time. Fetches lazily on
// expand so a household page with 12 people doesn't do 12 joins
// on load. The raw stores stay separate; this panel is a read
// projection.

type ActivityItem = CustomerActivityResponse["items"][number];

const personName = (p: Person): string => {
  const d = p.data as { fullName?: string; name?: string };
  return d.fullName ?? d.name ?? "(unnamed)";
};

const sourceLabel = (s: ActivityItem["source"]): string =>
  s === "sms" ? "SMS" : s === "whatsapp" ? "WhatsApp" : s === "imessage" ? "iMessage" : "Email";

export function CustomerActivity({
  householdId,
  people,
}: {
  householdId: HouseholdId;
  people: {
    principal: Person[];
    member: Person[];
    staff: Person[];
    contact: Person[];
  };
}) {
  // Only principals + members are treated as "customers" the manager
  // consolidates activity for. Staff and vendors have their own
  // channels but aren't the customer's account.
  const customers = [...people.principal, ...people.member];
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cache, setCache] = useState<
    Record<string, CustomerActivityResponse | { error: string }>
  >({});
  const [isPending, startTransition] = useTransition();

  if (customers.length === 0) return null;

  const toggle = (id: string): void => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!cache[id]) {
      startTransition(async () => {
        const res = await loadCustomerActivity(householdId, id);
        setCache((prev) => ({
          ...prev,
          [id]: res.data ?? { error: res.message },
        }));
      });
    }
  };

  return (
    <div>
      <div className="section-head">
        <h2>Customer activity</h2>
        <span className="mono">{customers.length}</span>
      </div>
      <p className="subtitle" style={{ marginTop: 0 }}>
        SMS and email consolidated per person.
      </p>
      <ul className="activity-people">
        {customers.map((p) => {
          const open = expanded === p.id;
          const cached = cache[p.id];
          return (
            <li key={p.id} className="activity-person">
              <button
                type="button"
                className="activity-person-header"
                onClick={() => toggle(p.id)}
              >
                <span className="activity-person-name">{personName(p)}</span>
                <span className="mono muted">
                  {cached && !("error" in cached)
                    ? `${cached.items.length} · sms ${cached.counts.sms} · email ${cached.counts.email}`
                    : "···"}
                </span>
                <span className="mono muted">{open ? "hide" : "show"}</span>
              </button>
              {open ? (
                <div className="activity-body">
                  {!cached ? (
                    <span className="muted">Loading…</span>
                  ) : "error" in cached ? (
                    <span className="muted">{cached.error}</span>
                  ) : cached.items.length === 0 ? (
                    <span className="muted">
                      No SMS or email tied to this person yet.
                    </span>
                  ) : (
                    <>
                      <div className="activity-endpoints">
                        {cached.endpoints.map((e) => (
                          <span key={e.id} className={`tag tag-${e.channel}`}>
                            {e.channel} · <span className="mono">{e.address}</span>
                          </span>
                        ))}
                      </div>
                      <ol className="activity-items">
                        {cached.items.map((item) => (
                          <li
                            key={`${item.refKind}-${item.refId}`}
                            className={`activity-item activity-${item.source} activity-${item.direction}`}
                          >
                            <div className="activity-item-head">
                              <span className={`tag tag-${item.source}`}>
                                {sourceLabel(item.source)}
                              </span>
                              <span className="mono muted">{item.direction}</span>
                              <span className="mono muted">
                                {new Date(item.at).toLocaleString()}
                              </span>
                            </div>
                            <div className="activity-item-body">{item.summary}</div>
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {isPending ? (
        <span className="muted mono" style={{ display: "block", marginTop: 8 }}>
          Loading…
        </span>
      ) : null}
    </div>
  );
}
