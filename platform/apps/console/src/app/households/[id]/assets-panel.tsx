"use client";

import { useState, useTransition } from "react";
import type { HouseholdId } from "@atelier/domain";
import { addAsset, removeAsset, updateAsset, type AssetKind } from "./actions";

interface Asset {
  id: string;
  data: Record<string, unknown>;
}
interface AssetBuckets {
  property: Asset[];
  vehicle: Asset[];
  equipment: Asset[];
  membership: Asset[];
  pet: Asset[];
}

const KIND_LABEL: Record<AssetKind, string> = {
  property: "Property",
  vehicle: "Vehicle",
  equipment: "Equipment",
  membership: "Membership",
  pet: "Pet",
};

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  kind?: "text" | "number" | "date" | "select";
  options?: string[];
  required?: boolean;
};

const fieldsFor = (kind: AssetKind): Field[] => {
  switch (kind) {
    case "property":
      return [
        { key: "label", label: "Label", placeholder: "Main house, ski cabin…", required: true },
        { key: "addressLine1", label: "Address line 1", required: true },
        { key: "addressLine2", label: "Address line 2" },
        { key: "city", label: "City", required: true },
        { key: "region", label: "Region" },
        { key: "postalCode", label: "Postal code" },
        { key: "country", label: "Country", required: true },
        {
          key: "role",
          label: "Role",
          kind: "select",
          options: ["primary_residence", "secondary_residence", "office", "storage", "other"],
          required: true,
        },
      ];
    case "vehicle":
      return [
        { key: "label", label: "Label", required: true },
        { key: "make", label: "Make", required: true },
        { key: "model", label: "Model", required: true },
        { key: "year", label: "Year", kind: "number" },
        { key: "vin", label: "VIN" },
      ];
    case "equipment":
      return [
        { key: "label", label: "Label", required: true },
        { key: "category", label: "Category", placeholder: "HVAC, boiler, appliance…", required: true },
        { key: "manufacturer", label: "Manufacturer" },
        { key: "model", label: "Model" },
        { key: "installedOn", label: "Installed on (YYYY-MM-DD)", kind: "date" },
      ];
    case "membership":
      return [
        { key: "label", label: "Label", required: true },
        { key: "organization", label: "Organization", required: true },
        { key: "memberSince", label: "Member since (YYYY-MM-DD)", kind: "date" },
        { key: "status", label: "Status" },
      ];
    case "pet":
      return [
        { key: "name", label: "Name", required: true },
        { key: "species", label: "Species", required: true },
        { key: "breed", label: "Breed" },
        { key: "dateOfBirth", label: "Date of birth (YYYY-MM-DD)", kind: "date" },
      ];
  }
};

const summarize = (kind: AssetKind, data: Record<string, unknown>): string => {
  if (kind === "pet") return String(data["name"] ?? "(no name)");
  const label = String(data["label"] ?? "(no label)");
  if (kind === "vehicle") {
    const year = data["year"];
    const make = data["make"];
    const model = data["model"];
    if (year && make && model) return `${label} · ${year} ${make} ${model}`;
    if (make && model) return `${label} · ${make} ${model}`;
    return label;
  }
  if (kind === "property") {
    const city = data["city"];
    const role = data["role"];
    return city ? `${label} · ${role ?? ""} · ${city}` : label;
  }
  if (kind === "membership") {
    const org = data["organization"];
    return org ? `${label} · ${org}` : label;
  }
  if (kind === "equipment") {
    const cat = data["category"];
    return cat ? `${label} · ${cat}` : label;
  }
  return label;
};

const toApiData = (
  kind: AssetKind,
  raw: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fieldsFor(kind)) {
    const v = raw[f.key];
    if (v === undefined || v === "") continue;
    if (f.kind === "number") {
      const n = Number(v);
      if (!Number.isNaN(n)) out[f.key] = n;
    } else {
      out[f.key] = v;
    }
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

function AssetRow({
  householdId,
  kind,
  asset,
  onRemoved,
  onUpdated,
}: {
  householdId: HouseholdId;
  kind: AssetKind;
  asset: Asset;
  onRemoved: () => void;
  onUpdated: (data: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(toFormData(asset.data));
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
              const res = await updateAsset(householdId, asset.id, toApiData(kind, form));
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
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                >
                  <option value="">—</option>
                  {f.options!.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.kind === "number" ? "number" : "text"}
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
                setForm(toFormData(asset.data));
              }}
            >
              Cancel
            </button>
            {message ? <span className="mono muted">{message}</span> : null}
          </div>
        </form>
      ) : (
        <div className="person-line">
          <span className="person-name">{summarize(kind, asset.data)}</span>
          <div className="person-actions">
            <button type="button" className="link-btn" onClick={() => setEditing(true)}>Edit</button>
            <button
              type="button"
              className="link-btn"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  const res = await removeAsset(householdId, asset.id);
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

function AddAssetForm({
  householdId,
  kind,
  onAdded,
}: {
  householdId: HouseholdId;
  kind: AssetKind;
  onAdded: (asset: Asset) => void;
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
          for (const f of fieldsFor(kind)) {
            if (f.required && !data[f.key]) {
              setMessage(`${f.label} is required.`);
              return;
            }
          }
          const res = await addAsset(householdId, { kind, data });
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
          ) : (
            <input
              type={f.kind === "number" ? "number" : "text"}
              value={form[f.key] ?? ""}
              placeholder={f.placeholder ?? ""}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          )}
        </label>
      ))}
      <div className="person-actions">
        <button type="submit" disabled={isPending}>Add {KIND_LABEL[kind].toLowerCase()}</button>
        {message ? <span className="mono muted">{message}</span> : null}
      </div>
    </form>
  );
}

export function AssetsPanel({
  householdId,
  initialAssets,
}: {
  householdId: HouseholdId;
  initialAssets: AssetBuckets;
}) {
  const [assets, setAssets] = useState<AssetBuckets>(initialAssets);
  const [addingKind, setAddingKind] = useState<AssetKind | null>(null);

  const total =
    assets.property.length +
    assets.vehicle.length +
    assets.equipment.length +
    assets.membership.length +
    assets.pet.length;

  const remove = (kind: AssetKind, id: string): void => {
    setAssets((prev) => ({ ...prev, [kind]: prev[kind].filter((a) => a.id !== id) }));
  };
  const update = (kind: AssetKind, id: string, data: Record<string, unknown>): void => {
    setAssets((prev) => ({
      ...prev,
      [kind]: prev[kind].map((a) => (a.id === id ? { ...a, data } : a)),
    }));
  };
  const add = (kind: AssetKind, asset: Asset): void => {
    setAssets((prev) => ({ ...prev, [kind]: [...prev[kind], asset] }));
    setAddingKind(null);
  };

  return (
    <div>
      <div className="section-head">
        <h2>Properties &amp; assets</h2>
        <span className="mono">
          {total} across properties + vehicles + equipment + memberships + pets
        </span>
      </div>
      {(Object.keys(KIND_LABEL) as AssetKind[]).map((kind) => (
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
          {assets[kind].length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="person-list">
              {assets[kind].map((a) => (
                <AssetRow
                  key={a.id}
                  householdId={householdId}
                  kind={kind}
                  asset={a}
                  onRemoved={() => remove(kind, a.id)}
                  onUpdated={(data) => update(kind, a.id, data)}
                />
              ))}
            </ul>
          )}
          {addingKind === kind ? (
            <AddAssetForm
              householdId={householdId}
              kind={kind}
              onAdded={(asset) => add(kind, asset)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
