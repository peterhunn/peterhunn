"use client";

import { useState, useTransition } from "react";
import type { HouseholdId } from "@atelier/domain";
import { addPerson, removePerson, updatePerson } from "./actions";

type Kind = "principal" | "member" | "staff" | "contact";
interface Person {
  id: string;
  data: Record<string, unknown>;
}
interface PeopleBuckets {
  principal: Person[];
  member: Person[];
  staff: Person[];
  contact: Person[];
}

const KIND_LABEL: Record<Kind, string> = {
  principal: "Principal",
  member: "Family member",
  staff: "Staff",
  contact: "Trusted contact",
};

// Which optional fields per kind are meaningful in the compact
// summary line. The full node shape is bigger; the panel edits the
// common fields inline and leaves richer edits to the graph browser.
const summarize = (kind: Kind, data: Record<string, unknown>): string => {
  const name = (data["fullName"] as string) ?? "(no name)";
  if (kind === "member") {
    const rel = data["relationToPrincipal"] as string | undefined;
    return rel ? `${name} · ${rel}` : name;
  }
  if (kind === "staff") {
    const role = data["role"] as string | undefined;
    return role ? `${name} · ${role}` : name;
  }
  if (kind === "contact") {
    const aff = data["affiliation"] as string | undefined;
    return aff ? `${name} · ${aff}` : name;
  }
  return name;
};

const fieldsFor = (kind: Kind): Array<{ key: string; label: string; placeholder?: string; kind?: "list" | "select"; options?: string[] }> => {
  switch (kind) {
    case "principal":
      return [
        { key: "fullName", label: "Full name" },
        { key: "preferredName", label: "Preferred name" },
        { key: "pronouns", label: "Pronouns" },
        { key: "emails", label: "Emails (comma-separated)", kind: "list" },
        { key: "phones", label: "Phones (comma-separated)", kind: "list" },
      ];
    case "member":
      return [
        { key: "fullName", label: "Full name" },
        { key: "preferredName", label: "Preferred name" },
        {
          key: "relationToPrincipal",
          label: "Relation",
          kind: "select",
          options: ["spouse", "child", "dependent", "parent", "sibling", "other"],
        },
      ];
    case "staff":
      return [
        { key: "fullName", label: "Full name" },
        { key: "role", label: "Role", placeholder: "Nanny, PA, chef…" },
        { key: "emails", label: "Emails (comma-separated)", kind: "list" },
        { key: "phones", label: "Phones (comma-separated)", kind: "list" },
      ];
    case "contact":
      return [
        { key: "fullName", label: "Full name" },
        { key: "role", label: "Role", placeholder: "Doctor, attorney, contractor…" },
        { key: "affiliation", label: "Affiliation" },
        { key: "emails", label: "Emails (comma-separated)", kind: "list" },
        { key: "phones", label: "Phones (comma-separated)", kind: "list" },
      ];
  }
};

const toApiData = (
  kind: Kind,
  raw: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of fieldsFor(kind)) {
    const v = raw[field.key];
    if (v === undefined || v === "") continue;
    if (field.kind === "list") {
      out[field.key] = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      out[field.key] = v;
    }
  }
  return out;
};

const toFormData = (data: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) out[k] = v.join(", ");
    else if (typeof v === "string") out[k] = v;
    else if (v == null) out[k] = "";
    else out[k] = String(v);
  }
  return out;
};

function PersonRow({
  householdId,
  kind,
  person,
  onRemoved,
  onUpdated,
}: {
  householdId: HouseholdId;
  kind: Kind;
  person: Person;
  onRemoved: () => void;
  onUpdated: (data: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(toFormData(person.data));
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
              const res = await updatePerson(householdId, person.id, toApiData(kind, form));
              setMessage(res.message);
              if (!res.message.startsWith("Error")) {
                onUpdated(toApiData(kind, form));
                setEditing(false);
              }
            });
          }}
        >
          {fieldsFor(kind).map((f) => (
            <label key={f.key} className="person-field">
              <span>{f.label}</span>
              {f.kind === "select" ? (
                <select
                  value={form[f.key] ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, [f.key]: e.target.value })
                  }
                >
                  <option value="">—</option>
                  {f.options!.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={form[f.key] ?? ""}
                  placeholder={f.placeholder ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, [f.key]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
          <div className="person-actions">
            <button type="submit" disabled={isPending}>
              Save
            </button>
            <button
              type="button"
              className="link-btn"
              disabled={isPending}
              onClick={() => {
                setEditing(false);
                setForm(toFormData(person.data));
              }}
            >
              Cancel
            </button>
            {message ? <span className="mono muted">{message}</span> : null}
          </div>
        </form>
      ) : (
        <div className="person-line">
          <span className="person-name">{summarize(kind, person.data)}</span>
          <div className="person-actions">
            <button
              type="button"
              className="link-btn"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="link-btn"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  const res = await removePerson(householdId, person.id);
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

function AddPersonForm({
  householdId,
  kind,
  onAdded,
}: {
  householdId: HouseholdId;
  kind: Kind;
  onAdded: (person: Person) => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="person-form"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const data = toApiData(kind, form);
          if (!data["fullName"]) {
            setMessage("Full name is required.");
            return;
          }
          const res = await addPerson(householdId, { kind, data });
          setMessage(res.message);
          if (!res.message.startsWith("Error") && res.id) {
            onAdded({ id: res.id, data });
            setForm({});
          }
        });
      }}
    >
      {fieldsFor(kind).map((f) => (
        <label key={f.key} className="person-field">
          <span>{f.label}</span>
          {f.kind === "select" ? (
            <select
              value={form[f.key] ?? ""}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            >
              <option value="">—</option>
              {f.options!.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
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
        <button type="submit" disabled={isPending}>
          Add {KIND_LABEL[kind].toLowerCase()}
        </button>
        {message ? <span className="mono muted">{message}</span> : null}
      </div>
    </form>
  );
}

export function PeoplePanel({
  householdId,
  initialPeople,
}: {
  householdId: HouseholdId;
  initialPeople: PeopleBuckets;
}) {
  const [people, setPeople] = useState<PeopleBuckets>(initialPeople);
  const [addingKind, setAddingKind] = useState<Kind | null>(null);

  const total =
    people.principal.length +
    people.member.length +
    people.staff.length +
    people.contact.length;

  const remove = (kind: Kind, id: string): void => {
    setPeople((prev) => ({
      ...prev,
      [kind]: prev[kind].filter((p) => p.id !== id),
    }));
  };
  const update = (kind: Kind, id: string, data: Record<string, unknown>): void => {
    setPeople((prev) => ({
      ...prev,
      [kind]: prev[kind].map((p) => (p.id === id ? { ...p, data } : p)),
    }));
  };
  const add = (kind: Kind, person: Person): void => {
    setPeople((prev) => ({
      ...prev,
      [kind]: [...prev[kind], person],
    }));
    setAddingKind(null);
  };

  return (
    <div>
      <div className="section-head">
        <h2>People</h2>
        <span className="mono">{total} across principals + members + staff + contacts</span>
      </div>
      {(Object.keys(KIND_LABEL) as Kind[]).map((kind) => (
        <div key={kind} className="people-section">
          <div className="people-section-head">
            <h3>{KIND_LABEL[kind]}s</h3>
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                setAddingKind((prev) => (prev === kind ? null : kind))
              }
            >
              {addingKind === kind ? "Cancel" : `+ Add ${KIND_LABEL[kind].toLowerCase()}`}
            </button>
          </div>
          {people[kind].length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="person-list">
              {people[kind].map((p) => (
                <PersonRow
                  key={p.id}
                  householdId={householdId}
                  kind={kind}
                  person={p}
                  onRemoved={() => remove(kind, p.id)}
                  onUpdated={(data) => update(kind, p.id, data)}
                />
              ))}
            </ul>
          )}
          {addingKind === kind ? (
            <AddPersonForm
              householdId={householdId}
              kind={kind}
              onAdded={(person) => add(kind, person)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
