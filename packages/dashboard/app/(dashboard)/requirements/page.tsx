"use client";

import { useState, useEffect, useCallback } from "react";
import {
  listTemplates,
  buildRequirements,
  type Template,
  type ContractRequirementsResponse,
} from "@/lib/api";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="px-2 py-1 text-xs font-medium text-indigo-600 border border-indigo-200 rounded hover:bg-indigo-50 transition-colors"
    >
      {copied ? "Copied!" : `Copy ${label}`}
    </button>
  );
}

export default function RequirementsPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);

  // Form fields
  const [templateHash, setTemplateHash] = useState("");
  const [resource, setResource] = useState("");
  const [description, setDescription] = useState("");
  const [expiresIn, setExpiresIn] = useState(3600);
  const [requiredPartyFields, setRequiredPartyFields] = useState("");
  const [requiredParties, setRequiredParties] = useState(1);
  const [negotiable, setNegotiable] = useState(false);
  const [negotiableFieldsJson, setNegotiableFieldsJson] = useState("[]");
  const [jurisdiction, setJurisdiction] = useState("");
  const [governingLaw, setGoverningLaw] = useState("");

  // State
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [result, setResult] = useState<ContractRequirementsResponse | null>(null);

  const loadTemplates = useCallback(async () => {
    try {
      const data = await listTemplates({ limit: 100 });
      setTemplates(data.templates);
      if (data.templates.length > 0) {
        setTemplateHash(data.templates[0].hash);
      }
    } catch {
      // Templates list failure is non-fatal — user can type hash manually
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setJsonError("");
    setResult(null);

    let parsedNegotiableFields: Array<{ field: string; description: string; allowedValues?: string[] }> = [];
    if (negotiable) {
      try {
        parsedNegotiableFields = JSON.parse(negotiableFieldsJson);
        if (!Array.isArray(parsedNegotiableFields)) {
          setJsonError("Negotiable fields must be a JSON array.");
          return;
        }
      } catch {
        setJsonError("Invalid JSON in negotiable fields.");
        return;
      }
    }

    const fields = requiredPartyFields
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    setSubmitting(true);
    try {
      const data = await buildRequirements({
        templateHash,
        resource,
        description,
        expiresIn,
        requiredPartyFields: fields,
        requiredParties,
        negotiable,
        ...(negotiable ? { negotiableFields: parsedNegotiableFields } : {}),
        ...(jurisdiction ? { jurisdiction } : {}),
        ...(governingLaw ? { governingLaw } : {}),
      });
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build requirements");
    } finally {
      setSubmitting(false);
    }
  }

  const resultJson = result ? JSON.stringify(result, null, 2) : "";
  const resultHeader = result ? btoa(JSON.stringify(result)) : "";

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900">Requirements Builder</h1>
        <p className="text-sm text-gray-500 mt-0.5">Build an X-490 contract requirements object.</p>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
        {/* Template */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Template</label>
          {templatesLoading ? (
            <p className="text-sm text-gray-400">Loading templates…</p>
          ) : templates.length > 0 ? (
            <select
              value={templateHash}
              onChange={(e) => setTemplateHash(e.target.value)}
              required
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              {templates.map((t) => (
                <option key={t.hash} value={t.hash}>
                  {t.title ?? t.hash.slice(0, 20) + "…"}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={templateHash}
              onChange={(e) => setTemplateHash(e.target.value)}
              required
              placeholder="Template hash"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          )}
        </div>

        {/* Resource */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Resource path</label>
          <input
            type="text"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            required
            placeholder="/api/resource"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            placeholder="A short description of this requirement"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {/* Expires In */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Expires In (seconds)</label>
          <input
            type="number"
            value={expiresIn}
            onChange={(e) => setExpiresIn(Number(e.target.value))}
            required
            min={60}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {/* Required Party Fields */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Required Party Fields</label>
          <input
            type="text"
            value={requiredPartyFields}
            onChange={(e) => setRequiredPartyFields(e.target.value)}
            placeholder="name, org, email"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-xs text-gray-400 mt-1">Comma-separated list of required fields.</p>
        </div>

        {/* Required Parties */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Required Parties</label>
          <input
            type="number"
            value={requiredParties}
            onChange={(e) => setRequiredParties(Number(e.target.value))}
            min={1}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {/* Negotiable */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={negotiable}
              onChange={(e) => setNegotiable(e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-sm font-medium text-gray-700">Negotiable</span>
          </label>
        </div>

        {/* Negotiable Fields — shown when negotiable is checked */}
        {negotiable && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Negotiable Fields (JSON)</label>
            <textarea
              value={negotiableFieldsJson}
              onChange={(e) => {
                setNegotiableFieldsJson(e.target.value);
                setJsonError("");
              }}
              rows={5}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              {`[{"field":"jurisdiction","description":"...","allowedValues":["US","UK"]}]`}
            </p>
            {jsonError && (
              <p className="text-xs text-red-600 mt-1">{jsonError}</p>
            )}
          </div>
        )}

        {/* Jurisdiction */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Jurisdiction (optional)</label>
          <input
            type="text"
            value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value)}
            placeholder="e.g. US"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {/* Governing Law */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Governing Law (optional)</label>
          <input
            type="text"
            value={governingLaw}
            onChange={(e) => setGoverningLaw(e.target.value)}
            placeholder="e.g. Delaware"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="pt-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-md transition-colors flex items-center gap-2"
          >
            {submitting && (
              <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
            )}
            {submitting ? "Building…" : "Build Requirements"}
          </button>
        </div>
      </form>

      {result && (
        <div className="mt-6 space-y-4">
          {/* JSON output */}
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-gray-900">Requirements JSON</p>
              <CopyButton value={resultJson} label="JSON" />
            </div>
            <pre className="text-xs text-gray-700 bg-gray-50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {resultJson}
            </pre>
          </div>

          {/* X-490-Requirements header */}
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-gray-900">X-490-Requirements header value</p>
              <CopyButton value={resultHeader} label="header" />
            </div>
            <pre className="text-xs text-gray-700 bg-gray-50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {resultHeader}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
