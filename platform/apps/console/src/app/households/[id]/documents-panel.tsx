"use client";

import { useState, useTransition } from "react";
import type { HouseholdId } from "@atelier/domain";
import {
  addDocument,
  removeDocument,
  updateDocument,
  type DocumentSubcategory,
} from "./actions";

interface Doc {
  id: string;
  data: Record<string, unknown>;
}
interface DocBuckets {
  identity: Doc[];
  legal: Doc[];
  policy: Doc[];
  record: Doc[];
  receipt: Doc[];
}

const SUB_LABEL: Record<DocumentSubcategory, string> = {
  identity: "Identity",
  legal: "Legal",
  policy: "Policy",
  record: "Record",
  receipt: "Receipt",
};

// DocumentData categories (from the ontology) — a document node
// carries both a subcategory (from its type: identity/legal/…) AND
// a category field on the data. Kept for compatibility with older
// document schemas; the subcategory is authoritative for grouping.
const DOC_CATEGORIES = [
  "identity",
  "legal",
  "policy",
  "record",
  "receipt",
  "other",
] as const;

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  kind?: "text" | "select" | "date" | "textarea";
  options?: string[];
  required?: boolean;
};

const FIELDS: Field[] = [
  { key: "title", label: "Title", required: true, placeholder: "US Passport, Homeowners policy…" },
  {
    key: "category",
    label: "Category (ontology)",
    kind: "select",
    options: DOC_CATEGORIES as unknown as string[],
    required: true,
  },
  { key: "storedAt", label: "Stored at", placeholder: "https://vault.example/passport.pdf" },
  { key: "expiresAt", label: "Expires (ISO datetime)", placeholder: "2026-12-31T00:00:00Z" },
  { key: "notes", label: "Notes", kind: "textarea" },
];

const summarize = (data: Record<string, unknown>): string => {
  const title = String(data["title"] ?? "(no title)");
  const expires = data["expiresAt"];
  if (typeof expires === "string" && expires) {
    return `${title} · expires ${new Date(expires).toLocaleDateString()}`;
  }
  return title;
};

const toApiData = (raw: Record<string, string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const v = raw[f.key];
    if (v === undefined || v === "") continue;
    out[f.key] = v;
  }
  return out;
};

const toFormData = (data: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v == null) out[k] = "";
    else if (typeof v === "string") out[k] = v;
    else out[k] = String(v);
  }
  return out;
};

function DocRow({
  householdId,
  doc,
  onRemoved,
  onUpdated,
}: {
  householdId: HouseholdId;
  doc: Doc;
  onRemoved: () => void;
  onUpdated: (data: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(toFormData(doc.data));
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <li className="person-row">
      {editing ? (
        <form
          className="person-form"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await updateDocument(householdId, doc.id, toApiData(form));
              setMessage(res.message);
              if (!res.message.startsWith("Error")) {
                onUpdated(toApiData(form));
                setEditing(false);
              }
            });
          }}
        >
          {FIELDS.map((f) => (
            <label key={f.key} className="person-field">
              <span>{f.label}</span>
              {f.kind === "select" ? (
                <select
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                >
                  <option value="">—</option>
                  {f.options!.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : f.kind === "textarea" ? (
                <textarea
                  value={form[f.key] ?? ""}
                  rows={2}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              ) : (
                <input
                  value={form[f.key] ?? ""}
                  placeholder={f.placeholder ?? ""}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          <div className="person-actions">
            <button type="submit" disabled={isPending}>Save</button>
            <button
              type="button"
              className="link-btn"
              disabled={isPending}
              onClick={() => {
                setEditing(false);
                setForm(toFormData(doc.data));
              }}
            >
              Cancel
            </button>
            {message ? <span className="mono muted">{message}</span> : null}
          </div>
        </form>
      ) : (
        <div className="person-line">
          <span className="person-name">{summarize(doc.data)}</span>
          <div className="person-actions">
            <button type="button" className="link-btn" onClick={() => setEditing(true)}>Edit</button>
            <button
              type="button"
              className="link-btn"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  const res = await removeDocument(householdId, doc.id);
                  setMessage(res.message);
                  if (!res.message.startsWith("Error")) onRemoved();
                })
              }
            >
              Remove
            </button>
            {message ? <span className="mono muted">{message}</span> : null}
          </div>
        </div>
      )}
    </li>
  );
}

function AddDocForm({
  householdId,
  subcategory,
  onAdded,
}: {
  householdId: HouseholdId;
  subcategory: DocumentSubcategory;
  onAdded: (doc: Doc) => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({
    category: subcategory,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="person-form"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const data = toApiData(form);
          for (const f of FIELDS) {
            if (f.required && !data[f.key]) {
              setMessage(`${f.label} is required.`);
              return;
            }
          }
          const res = await addDocument(householdId, { subcategory, data });
          setMessage(res.message);
          if (!res.message.startsWith("Error") && res.id) {
            onAdded({ id: res.id, data });
            setForm({ category: subcategory });
          }
        });
      }}
    >
      {FIELDS.map((f) => (
        <label key={f.key} className="person-field">
          <span>
            {f.label}
            {f.required ? " *" : ""}
          </span>
          {f.kind === "select" ? (
            <select
              value={form[f.key] ?? ""}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            >
              <option value="">—</option>
              {f.options!.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : f.kind === "textarea" ? (
            <textarea
              value={form[f.key] ?? ""}
              rows={2}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          ) : (
            <input
              value={form[f.key] ?? ""}
              placeholder={f.placeholder ?? ""}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          )}
        </label>
      ))}
      <div className="person-actions">
        <button type="submit" disabled={isPending}>Add {SUB_LABEL[subcategory].toLowerCase()} document</button>
        {message ? <span className="mono muted">{message}</span> : null}
      </div>
    </form>
  );
}

export function DocumentsPanel({
  householdId,
  initialDocuments,
}: {
  householdId: HouseholdId;
  initialDocuments: DocBuckets;
}) {
  const [documents, setDocuments] = useState<DocBuckets>(initialDocuments);
  const [addingSub, setAddingSub] = useState<DocumentSubcategory | null>(null);

  const total =
    documents.identity.length +
    documents.legal.length +
    documents.policy.length +
    documents.record.length +
    documents.receipt.length;

  const remove = (sub: DocumentSubcategory, id: string): void =>
    setDocuments((prev) => ({ ...prev, [sub]: prev[sub].filter((d) => d.id !== id) }));
  const update = (
    sub: DocumentSubcategory,
    id: string,
    data: Record<string, unknown>,
  ): void =>
    setDocuments((prev) => ({
      ...prev,
      [sub]: prev[sub].map((d) => (d.id === id ? { ...d, data } : d)),
    }));
  const add = (sub: DocumentSubcategory, doc: Doc): void => {
    setDocuments((prev) => ({ ...prev, [sub]: [...prev[sub], doc] }));
    setAddingSub(null);
  };

  return (
    <div>
      <div className="section-head">
        <h2>Documents</h2>
        <span className="mono">{total} across identity + legal + policy + record + receipt</span>
      </div>
      {(Object.keys(SUB_LABEL) as DocumentSubcategory[]).map((sub) => (
        <div key={sub} className="people-section">
          <div className="people-section-head">
            <h3>{SUB_LABEL[sub]}</h3>
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                setAddingSub((prev) => (prev === sub ? null : sub))
              }
            >
              {addingSub === sub ? "Cancel" : `+ Add ${SUB_LABEL[sub].toLowerCase()} document`}
            </button>
          </div>
          {documents[sub].length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="person-list">
              {documents[sub].map((d) => (
                <DocRow
                  key={d.id}
                  householdId={householdId}
                  doc={d}
                  onRemoved={() => remove(sub, d.id)}
                  onUpdated={(data) => update(sub, d.id, data)}
                />
              ))}
            </ul>
          )}
          {addingSub === sub ? (
            <AddDocForm
              householdId={householdId}
              subcategory={sub}
              onAdded={(doc) => add(sub, doc)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
