"use client";

import { useState, useEffect, useCallback } from "react";
import { getAuth } from "@/lib/auth";
import { listWebhooks, createWebhook, deleteWebhook, type Webhook } from "@/lib/api";
import { Badge } from "@/components/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyBox } from "@/components/copy-box";

const ALL_EVENTS = ["agreement.created", "agreement.revoked"] as const;

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleString();
}

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([...ALL_EVENTS]);
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ webhookId: string; secret: string } | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const data = await listWebhooks(auth);
      setWebhooks(data.webhooks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  function toggleEvent(event: string) {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const auth = getAuth();
    if (!auth) return;
    if (selectedEvents.length === 0) {
      setError("Select at least one event.");
      return;
    }
    setCreating(true);
    try {
      const result = await createWebhook(auth, webhookUrl, selectedEvents);
      setCreatedSecret({ webhookId: result.webhookId, secret: result.secret });
      setWebhookUrl("");
      setSelectedEvents([...ALL_EVENTS]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const auth = getAuth();
    if (!auth) return;
    try {
      await deleteWebhook(auth, deleteTarget);
      setConfirmOpen(false);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete webhook");
      setConfirmOpen(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Webhooks</h1>
        <button
          onClick={() => setCreateOpen(true)}
          className="px-3 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors"
        >
          Register webhook
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : webhooks.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">No webhooks registered.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {["URL", "Events", "Status", "Created", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {webhooks.map((w) => (
                <tr key={w.webhookId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate font-mono text-xs" title={w.url}>
                    {w.url}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {w.events.map((ev) => (
                        <Badge key={ev} variant="grey">{ev}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {w.active ? <Badge variant="green">Active</Badge> : <Badge variant="red">Disabled</Badge>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(w.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => { setDeleteTarget(w.webhookId); setConfirmOpen(true); }}
                      className="text-xs text-red-600 hover:text-red-800 font-medium"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create webhook modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => { setCreateOpen(false); setCreatedSecret(null); }} />
          <div className="relative bg-white rounded-xl shadow-lg border border-gray-200 w-full max-w-sm p-6 mx-4">
            {createdSecret ? (
              <>
                <h2 className="text-base font-semibold text-gray-900 mb-2">Webhook registered</h2>
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-4">
                  Store this signing secret — it will not be shown again.
                </p>
                <CopyBox value={createdSecret.secret} label="Signing Secret" />
                <div className="mt-5 text-right">
                  <button
                    onClick={() => { setCreateOpen(false); setCreatedSecret(null); }}
                    className="px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-gray-900 mb-4">Register webhook</h2>
                <form onSubmit={handleCreate} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">URL</label>
                    <input
                      type="url"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      required
                      placeholder="https://example.com/webhook"
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Events</label>
                    <div className="space-y-2">
                      {ALL_EVENTS.map((ev) => (
                        <label key={ev} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedEvents.includes(ev)}
                            onChange={() => toggleEvent(ev)}
                            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="text-sm text-gray-700 font-mono">{ev}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => { setCreateOpen(false); setCreatedSecret(null); }}
                      className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={creating}
                      className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-md transition-colors"
                    >
                      {creating ? "Registering…" : "Register"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Delete webhook"
        message="This will permanently delete the webhook. No more events will be delivered to this URL."
        onConfirm={handleDelete}
        onCancel={() => { setConfirmOpen(false); setDeleteTarget(null); }}
      />
    </div>
  );
}
