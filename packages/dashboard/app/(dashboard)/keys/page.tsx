"use client";

import { useState, useEffect, useCallback } from "react";
import { listApiKeys, createApiKey, revokeApiKey, type ApiKey } from "@/lib/api";
import { Badge } from "@/components/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyBox } from "@/components/copy-box";

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleString();
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ keyId: string; apiKey: string } | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listApiKeys();
      setKeys(data.apiKeys);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const result = await createApiKey(newKeyName.trim() || "default");
      setNewKey(result);
      setNewKeyName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    try {
      await revokeApiKey(revokeTarget);
      setConfirmOpen(false);
      setRevokeTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key");
      setConfirmOpen(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">API Keys</h1>
        <button
          onClick={() => setCreateOpen(true)}
          className="px-3 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors"
        >
          Create key
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : keys.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">No API keys found.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {["Name", "Status", "Created", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {keys.map((k) => (
                <tr key={k.keyId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{k.name}</td>
                  <td className="px-4 py-3">
                    {k.revokedAt ? <Badge variant="red">Revoked</Badge> : <Badge variant="green">Active</Badge>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(k.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {!k.revokedAt && (
                      <button
                        onClick={() => { setRevokeTarget(k.keyId); setConfirmOpen(true); }}
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
      )}

      {/* Create key modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => { setCreateOpen(false); setNewKey(null); }} />
          <div className="relative bg-white rounded-xl shadow-lg border border-gray-200 w-full max-w-sm p-6 mx-4">
            {newKey ? (
              <>
                <h2 className="text-base font-semibold text-gray-900 mb-2">Key created</h2>
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-4">
                  Store this key — it will not be shown again.
                </p>
                <CopyBox value={newKey.apiKey} label="API Key" />
                <div className="mt-5 text-right">
                  <button
                    onClick={() => { setCreateOpen(false); setNewKey(null); }}
                    className="px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-gray-900 mb-4">Create API key</h2>
                <form onSubmit={handleCreate} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                    <input
                      type="text"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      placeholder="e.g. production"
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => { setCreateOpen(false); setNewKey(null); }}
                      className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={creating}
                      className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-md transition-colors"
                    >
                      {creating ? "Creating…" : "Create"}
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
        title="Revoke API key"
        message="This will permanently revoke the key. Any integrations using it will stop working."
        onConfirm={handleRevoke}
        onCancel={() => { setConfirmOpen(false); setRevokeTarget(null); }}
      />
    </div>
  );
}
