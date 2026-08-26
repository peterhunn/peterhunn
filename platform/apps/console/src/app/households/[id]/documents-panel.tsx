"use client";

import { useMemo, useState, useTransition } from "react";
import type { HouseholdId } from "@atelier/domain";
import {
  addDocument,
  loadDocumentAudit,
  removeDocument,
  resolveDocumentExtraction,
  updateDocument,
  type DocumentAuditEvent,
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

const hasBlob = (data: Record<string, unknown>): boolean => {
  const s = data["storedAt"];
  return typeof s === "string" && s.startsWith("atelier://blob/");
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

interface PendingExtraction {
  provider: "anthropic" | "mock";
  reason?: string;
  proposed: Record<string, unknown>;
  createdAt: string;
}

interface AutoRecategorised {
  from: string;
  to: string;
  source: string;
}

const readPending = (
  data: Record<string, unknown>,
): PendingExtraction | null => {
  const v = data["pendingExtraction"];
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<PendingExtraction>;
  if (!r.provider || !r.proposed || !r.createdAt) return null;
  return r as PendingExtraction;
};

const stringifyValue = (v: unknown): string =>
  typeof v === "string" ? v : JSON.stringify(v);

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
  // Recent auto-recategorise info lives in memory only — comes
  // from the upload response, not persisted on the node.
  const [autoRecategorised, setAutoRecategorised] =
    useState<AutoRecategorised | null>(null);
  const [isPending, startTransition] = useTransition();

  // The extraction proposal is now persistent on the node data
  // (server writes it there on upload); the review card renders
  // straight from doc.data so a refresh doesn't lose it.
  const pending = useMemo(() => readPending(doc.data), [doc.data]);
  const proposedEntries = useMemo(
    () =>
      pending ? Object.entries(pending.proposed).filter(([k]) => k !== "storedAt") : [],
    [pending],
  );

  // Per-field accept toggle + inline edits, defaulted to "all
  // proposed fields accepted with the LLM's values" so the
  // common case ("looks right, ship it") is one click.
  const [acceptSet, setAcceptSet] = useState<Set<string>>(
    () => new Set(proposedEntries.map(([k]) => k)),
  );
  const [edits, setEdits] = useState<Record<string, string>>(() =>
    Object.fromEntries(proposedEntries.map(([k, v]) => [k, stringifyValue(v)])),
  );

  const anyAccepted = acceptSet.size > 0;

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<DocumentAuditEvent[] | null>(null);

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
          <span className="person-name">
            {summarize(doc.data)}
            {hasBlob(doc.data) ? (
              <span className="tag tag-attached" title="File attached">
                {" file attached"}
              </span>
            ) : null}
          </span>
          <div className="person-actions">
            <label className="link-btn attach-label">
              {hasBlob(doc.data) ? "Replace file" : "Attach file"}
              <input
                type="file"
                style={{ display: "none" }}
                disabled={isPending}
                onChange={(evt) => {
                  const file = evt.target.files?.[0];
                  if (!file) return;
                  startTransition(async () => {
                    setMessage("Uploading…");
                    try {
                      const resp = await fetch(
                        `/api/documents/${householdId}/${doc.id}/file`,
                        {
                          method: "PUT",
                          headers: {
                            "content-type": file.type || "application/octet-stream",
                            "x-original-filename": file.name,
                          },
                          body: await file.arrayBuffer(),
                        },
                      );
                      if (!resp.ok) {
                        setMessage(`Error: ${resp.status}`);
                        return;
                      }
                      const json = (await resp.json()) as {
                        blob: { sha256: string; deduped: boolean };
                        document: {
                          id: string;
                          data: Record<string, unknown>;
                          autoRecategorised?: AutoRecategorised;
                        };
                      };
                      setMessage(
                        json.blob.deduped
                          ? `Uploaded (deduped ${json.blob.sha256.slice(0, 8)}).`
                          : `Uploaded ${json.blob.sha256.slice(0, 8)}.`,
                      );
                      onUpdated(json.document.data);
                      if (json.document.autoRecategorised) {
                        setAutoRecategorised(json.document.autoRecategorised);
                      }
                      // Reset the accept form so its defaults track
                      // whatever proposal the server just persisted.
                      const nextPending = readPending(json.document.data);
                      const nextEntries = nextPending
                        ? Object.entries(nextPending.proposed).filter(
                            ([k]) => k !== "storedAt",
                          )
                        : [];
                      setAcceptSet(new Set(nextEntries.map(([k]) => k)));
                      setEdits(
                        Object.fromEntries(
                          nextEntries.map(([k, v]) => [k, stringifyValue(v)]),
                        ),
                      );
                    } catch (err) {
                      setMessage(`Error: ${(err as Error).message}`);
                    }
                  });
                  // reset so the same file can be re-selected
                  evt.target.value = "";
                }}
              />
            </label>
            {hasBlob(doc.data) ? (
              <a
                className="link-btn"
                href={`/api/documents/${householdId}/${doc.id}/file`}
                target="_blank"
                rel="noreferrer"
              >
                Download
              </a>
            ) : null}
            <button type="button" className="link-btn" onClick={() => setEditing(true)}>Edit</button>
            <button
              type="button"
              className="link-btn"
              disabled={isPending}
              onClick={() => {
                setHistoryOpen((prev) => !prev);
                if (!historyOpen && history === null) {
                  startTransition(async () => {
                    const res = await loadDocumentAudit(householdId, doc.id);
                    setMessage(res.message);
                    setHistory(res.events ?? []);
                  });
                }
              }}
            >
              {historyOpen ? "Hide history" : "History"}
            </button>
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

      {autoRecategorised ? (
        <div className="extraction-recat">
          Auto-moved from <span className="mono">{autoRecategorised.from}</span>{" "}
          to <span className="mono">{autoRecategorised.to}</span> by{" "}
          {autoRecategorised.source}.
        </div>
      ) : null}

      {historyOpen ? (
        <div className="doc-history">
          {history === null ? (
            <span className="muted">Loading history…</span>
          ) : history.length === 0 ? (
            <span className="muted">No audit events for this document yet.</span>
          ) : (
            <ol className="doc-history-list">
              {history.map((ev) => (
                <li key={ev.id} className="doc-history-item">
                  <div className="doc-history-head">
                    <span className="mono">{ev.action}</span>
                    <span className="muted">
                      {new Date(ev.at).toLocaleString()} · {ev.actorType}
                      {ev.actorId ? ` ${ev.actorId.slice(0, 8)}` : ""}
                    </span>
                  </div>
                  {ev.action === "documents.extraction.resolve" && ev.metadata.route ? (
                    <ExtractionResolveDetail route={ev.metadata.route} />
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}

      {pending && proposedEntries.length > 0 ? (
        <div className="extraction-review">
          <div className="extraction-header">
            <strong>Fields extracted from file</strong>
            <span className="mono muted">
              via {pending.provider}
              {pending.reason ? ` — ${pending.reason}` : ""}
              {" · "}
              {new Date(pending.createdAt).toLocaleString()}
            </span>
          </div>
          <ul className="extraction-fields">
            {proposedEntries.map(([k, v]) => {
              const accepted = acceptSet.has(k);
              const originalValue = stringifyValue(v);
              const currentEdit = edits[k] ?? originalValue;
              const edited = currentEdit !== originalValue;
              return (
                <li key={k} className="extraction-row">
                  <label className="extraction-toggle">
                    <input
                      type="checkbox"
                      checked={accepted}
                      onChange={(e) => {
                        setAcceptSet((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(k);
                          else next.delete(k);
                          return next;
                        });
                      }}
                    />
                    <span className="mono muted">{k}</span>
                  </label>
                  <input
                    type="text"
                    value={currentEdit}
                    disabled={!accepted}
                    onChange={(e) =>
                      setEdits((prev) => ({ ...prev, [k]: e.target.value }))
                    }
                  />
                  {edited && accepted ? (
                    <span className="mono muted extraction-edited">edited</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="person-actions">
            <button
              type="button"
              disabled={isPending || !anyAccepted}
              onClick={() =>
                startTransition(async () => {
                  const accept = Array.from(acceptSet);
                  const editsPayload: Record<string, unknown> = {};
                  for (const k of accept) {
                    const original = stringifyValue(pending.proposed[k]);
                    if ((edits[k] ?? original) !== original) {
                      editsPayload[k] = edits[k];
                    }
                  }
                  const res = await resolveDocumentExtraction(
                    householdId,
                    doc.id,
                    Object.keys(editsPayload).length > 0
                      ? { accept, edits: editsPayload }
                      : { accept },
                  );
                  setMessage(res.message);
                  if (!res.message.startsWith("Error") && res.data) {
                    onUpdated(res.data);
                  }
                })
              }
            >
              Apply {acceptSet.size} field{acceptSet.size === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              className="link-btn"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  const res = await resolveDocumentExtraction(
                    householdId,
                    doc.id,
                    { accept: [] },
                  );
                  setMessage(res.message);
                  if (!res.message.startsWith("Error") && res.data) {
                    onUpdated(res.data);
                  }
                })
              }
            >
              Dismiss all
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function ExtractionResolveDetail({ route }: { route: Record<string, unknown> }) {
  const accepted = Array.isArray(route.accepted) ? (route.accepted as string[]) : [];
  const rejected = Array.isArray(route.rejected) ? (route.rejected as string[]) : [];
  const edited = Array.isArray(route.editedKeys)
    ? (route.editedKeys as string[])
    : [];
  const applied = (route.appliedFields as Record<string, unknown> | undefined) ?? {};
  const proposed =
    ((route.pendingBefore as { proposed?: Record<string, unknown> } | undefined)
      ?.proposed) ?? {};
  return (
    <div className="doc-history-detail">
      {accepted.length > 0 ? (
        <ul className="doc-history-fields">
          {accepted.map((k) => {
            const wasEdited = edited.includes(k);
            return (
              <li key={k}>
                <span className="mono">{k}</span>{" "}
                <span>{stringifyValue(applied[k])}</span>
                {wasEdited ? (
                  <>
                    {" "}
                    <span className="muted">
                      ← LLM proposed: {stringifyValue(proposed[k])}
                    </span>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="muted">No fields accepted (dismissed).</span>
      )}
      {rejected.length > 0 ? (
        <div className="muted doc-history-rejected">
          Rejected: {rejected.map((k) => `${k} (“${stringifyValue(proposed[k])}”)`).join(", ")}
        </div>
      ) : null}
    </div>
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
