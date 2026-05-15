"use client";

import { useState, useEffect, useCallback } from "react";
import { listTemplates, type Template, type ContractTerms } from "@/lib/api";

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleString();
}

const TERMS_LABELS: { key: keyof ContractTerms; label: string }[] = [
  { key: "liabilityCap", label: "Liability Cap" },
  { key: "governingLaw", label: "Governing Law" },
  { key: "jurisdiction", label: "Jurisdiction" },
  { key: "terminationNotice", label: "Termination Notice" },
  { key: "paymentTerms", label: "Payment Terms" },
  { key: "autoRenewal", label: "Auto Renewal" },
  { key: "disputeResolution", label: "Dispute Resolution" },
  { key: "indemnification", label: "Indemnification" },
  { key: "confidentiality", label: "Confidentiality" },
];

function TermsTable({ terms }: { terms: ContractTerms }) {
  const rows = TERMS_LABELS.filter(({ key }) => terms[key] !== undefined);
  const extras = terms.extras ? Object.entries(terms.extras) : [];
  if (rows.length === 0 && extras.length === 0) return <p className="text-xs text-gray-400 italic">No structured terms.</p>;
  return (
    <table className="text-xs divide-y divide-gray-100 w-full">
      <tbody>
        {rows.map(({ key, label }) => (
          <tr key={key}>
            <td className="py-1 pr-3 text-gray-500 font-medium w-40">{label}</td>
            <td className="py-1 text-gray-700">{String(terms[key])}</td>
          </tr>
        ))}
        {extras.map(([k, v]) => (
          <tr key={k}>
            <td className="py-1 pr-3 text-gray-500 font-medium w-40">{k}</td>
            <td className="py-1 text-gray-700">{String(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TemplateCard({ template }: { template: Template }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-900 text-sm truncate">
            {template.title ?? "(untitled)"}
          </p>
          {template.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{template.description}</p>
          )}
          <p className="font-mono text-xs text-gray-400 mt-1 truncate" title={template.hash}>
            {template.hash.slice(0, 16)}…
          </p>
          <p className="text-xs text-gray-400 mt-0.5">{formatDate(template.createdAt)}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          {template.terms && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {expanded ? "Hide terms" : "View terms"}
            </button>
          )}
          <a
            href={template.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-2 py-1 rounded border border-gray-200 text-indigo-600 hover:bg-indigo-50 transition-colors"
          >
            Content
          </a>
        </div>
      </div>

      {expanded && template.terms && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Structured Terms</p>
          <TermsTable terms={template.terms} />
        </div>
      )}
    </div>
  );
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (cursor?: string) => {
    try {
      const data = await listTemplates({ limit: 50, ...(cursor ? { after: cursor } : {}) });
      if (cursor) {
        setTemplates((prev) => [...prev, ...data.templates]);
      } else {
        setTemplates(data.templates);
      }
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    await load(nextCursor);
    setLoadingMore(false);
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900">Templates</h1>
        <p className="text-sm text-gray-500 mt-0.5">Contract templates registered by your tenant.</p>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : templates.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          No templates registered yet.
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {templates.map((t) => (
              <TemplateCard key={t.hash} template={t} />
            ))}
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
    </div>
  );
}
