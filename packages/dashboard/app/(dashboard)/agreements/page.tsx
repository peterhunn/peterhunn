"use client";

import { useState, useEffect, useCallback } from "react";
import { useTenant } from "@/lib/tenant-context";
import { listAgreements, revokeAgreement, listContractEvents, type Agreement, type ContractEvent } from "@/lib/api";
import { Badge } from "@/components/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleString();
}

export default function AgreementsPage() {
  const tenant = useTenant();
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [resourceFilter, setResourceFilter] = useState("");
  const [filterInput, setFilterInput] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const [eventsOpen, setEventsOpen] = useState(false);
  const [eventsContractId, setEventsContractId] = useState<string | null>(null);
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  const load = useCallback(async (resource: string, cursor?: string) => {
    try {
      const data = await listAgreements({
        ...(resource ? { resource } : {}),
        ...(cursor ? { after: cursor } : {}),
        limit: 50,
      });
      if (cursor) {
        setAgreements((prev) => [...prev, ...data.agreements]);
      } else {
        setAgreements(data.agreements);
      }
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agreements");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load(resourceFilter).finally(() => setLoading(false));
  }, [resourceFilter, load]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    await load(resourceFilter, nextCursor);
    setLoadingMore(false);
  }

  function handleFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResourceFilter(filterInput.trim());
  }

  function openRevoke(contractId: string) {
    setRevokeTarget(contractId);
    setConfirmOpen(true);
  }

  async function openEvents(contractId: string) {
    setEventsContractId(contractId);
    setEventsOpen(true);
    setEventsLoading(true);
    try {
      const data = await listContractEvents(contractId);
      setEvents(data.events);
    } catch {
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget || !tenant) return;
    setRevoking(true);
    try {
      await revokeAgreement(tenant.tenantId, revokeTarget);
      setConfirmOpen(false);
      setRevokeTarget(null);
      await load(resourceFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
      setConfirmOpen(false);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Agreements</h1>
        <form onSubmit={handleFilterSubmit} className="flex gap-2">
          <input
            type="text"
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            placeholder="Filter by resource…"
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            className="px-3 py-1.5 text-sm font-medium bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            Filter
          </button>
          {resourceFilter && (
            <button
              type="button"
              onClick={() => { setFilterInput(""); setResourceFilter(""); }}
              className="px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : agreements.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">No agreements found.</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {["Party", "Resource", "Issued", "Expires", "Status", "Actions"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {agreements.map((a) => (
                  <tr key={a.contractId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-[140px] truncate" title={a.partyId}>
                      {a.partyId}
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-[160px] truncate" title={a.resource}>
                      {a.resource}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(a.issuedAt)}</td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(a.expiresAt)}</td>
                    <td className="px-4 py-3">
                      {a.revokedAt ? (
                        <Badge variant="red">Revoked</Badge>
                      ) : (
                        <Badge variant="green">Active</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => openEvents(a.contractId)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium mr-3"
                      >
                        Events
                      </button>
                      {!a.revokedAt && (
                        <button
                          onClick={() => openRevoke(a.contractId)}
                          className="text-xs text-red-600 hover:text-red-800 font-medium"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {nextCursor && (
            <div className="mt-4 text-center">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="px-4 py-2 text-sm font-medium bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Revoke agreement"
        message="This will permanently revoke the agreement. The party will no longer be able to verify their token."
        onConfirm={handleRevoke}
        onCancel={() => { setConfirmOpen(false); setRevokeTarget(null); }}
      />
      {revoking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/10">
          <span className="text-sm text-gray-600">Revoking…</span>
        </div>
      )}

      {eventsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setEventsOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-lg w-full max-w-lg max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <p className="font-semibold text-gray-900 text-sm">Contract Events</p>
                <p className="font-mono text-xs text-gray-400 mt-0.5 truncate">{eventsContractId}</p>
              </div>
              <button
                onClick={() => setEventsOpen(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4">
              {eventsLoading ? (
                <p className="text-sm text-gray-500">Loading events…</p>
              ) : events.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No events recorded.</p>
              ) : (
                <ol className="space-y-3">
                  {events.map((ev, i) => (
                    <li key={ev.eventId} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-medium shrink-0">
                          {i + 1}
                        </div>
                        {i < events.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1" />}
                      </div>
                      <div className="pb-3 min-w-0">
                        <p className="text-sm font-medium text-gray-800">{ev.type}</p>
                        {ev.party && <p className="text-xs text-gray-500">Party: {ev.party}</p>}
                        <p className="text-xs text-gray-400">{new Date(ev.createdAt * 1000).toLocaleString()}</p>
                        {ev.parentEventIds.length > 0 && (
                          <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">
                            ↑ {ev.parentEventIds[0]}
                          </p>
                        )}
                        {Object.keys(ev.payload).length > 0 && (
                          <details className="mt-1">
                            <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">Payload</summary>
                            <pre className="text-xs text-gray-600 bg-gray-50 rounded p-2 mt-1 overflow-x-auto">
                              {JSON.stringify(ev.payload, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
