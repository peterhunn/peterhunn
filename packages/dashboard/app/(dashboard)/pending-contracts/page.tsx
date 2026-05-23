"use client";

import { useEffect, useState } from "react";
import { listPendingContracts, type PendingContract } from "@/lib/api";

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function truncate(s: string, n = 8): string {
  return s.length > n ? s.slice(0, n) : s;
}

function partyName(acceptance: PendingContract["acceptances"][number]): string {
  return acceptance.partyData["name"] ?? acceptance.partyId;
}

export default function PendingContractsPage() {
  const [contracts, setContracts] = useState<PendingContract[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPendingContracts()
      .then((data) => setContracts(data.pendingContracts))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-6">
        Pending Contracts
      </h1>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {contracts === null && !error && (
        <div className="space-y-3 animate-pulse">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-lg bg-gray-200 dark:bg-gray-700"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {contracts !== null && contracts.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 py-16 text-center text-gray-500 dark:text-gray-400">
          No pending contracts
        </div>
      )}

      {/* Table */}
      {contracts !== null && contracts.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <th className="px-4 py-3">Contract ID</th>
                <th className="px-4 py-3">Template</th>
                <th className="px-4 py-3">Progress</th>
                <th className="px-4 py-3">Signed by</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {contracts.map((contract) => (
                <tr
                  key={contract.contractId}
                  className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-gray-700 dark:text-gray-300">
                    {truncate(contract.contractId)}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-700 dark:text-gray-300">
                    {truncate(contract.templateHash)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
                      {contract.acceptances.length} / {contract.requiredParties} signed
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                    {contract.acceptances.length > 0
                      ? contract.acceptances.map(partyName).join(", ")
                      : <span className="italic text-gray-400 dark:text-gray-500">none</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {formatDate(contract.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
