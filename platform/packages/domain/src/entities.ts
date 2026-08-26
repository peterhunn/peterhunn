import { z } from "zod";

// Life Graph node data schemas, organized by Accord Project category
// (Participant / Asset / Concept / Event / Transaction). We don't
// depend on Concerto — Zod stays the runtime authority — but the
// bucketing is deliberate:
//
//   Participant  people + organizations the service acts on behalf
//                of or toward (person.*, org.*)
//   Asset        long-lived things the household owns or holds
//                (place.property, asset.*, document.*)
//   Concept      reusable value objects that aren't owned themselves
//                (place.address, preference.*)
//   Event        things that happened or are scheduled to happen
//                (obligation.*)
//   Transaction  ledgered actions with side effects (the `action`
//                node is the graph-side projection; the full ledger
//                lives in the actions table)
//
// The ontology's discriminated union at the bottom stamps each type
// with its category so callers can enumerate by bucket without a
// hand-rolled map (see NODE_TYPE_SPECS + nodeTypesByCategory).
// A build-step CTO exporter (see packages/domain/src/cto-export.ts)
// turns these into an Accord Project namespace when the model needs
// to leave the runtime — e.g. for interop with a legal-tech tool.

// ═══════════════════════════════════════════════════════════════════
// Participants — people + organizations
// ═══════════════════════════════════════════════════════════════════

export const PersonPrincipalData = z.object({
  fullName: z.string(),
  preferredName: z.string().optional(),
  pronouns: z.string().optional(),
  dateOfBirth: z.string().date().optional(),
  emails: z.array(z.string().email()).default([]),
  phones: z.array(z.string()).default([]),
});

export const PersonMemberData = z.object({
  fullName: z.string(),
  preferredName: z.string().optional(),
  pronouns: z.string().optional(),
  dateOfBirth: z.string().date().optional(),
  relationToPrincipal: z.enum(["spouse", "child", "dependent", "parent", "sibling", "other"]),
});

export const PersonStaffData = z.object({
  fullName: z.string(),
  role: z.string(),
  emails: z.array(z.string().email()).default([]),
  phones: z.array(z.string()).default([]),
});

export const PersonContactData = z.object({
  fullName: z.string(),
  role: z.string().optional(),
  affiliation: z.string().optional(),
  emails: z.array(z.string().email()).default([]),
  phones: z.array(z.string()).default([]),
});

export const OrgData = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════
// Assets — long-lived things the household owns or holds
// ═══════════════════════════════════════════════════════════════════

export const PlacePropertyData = z.object({
  label: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string(),
  role: z.enum(["primary_residence", "secondary_residence", "office", "storage", "other"]),
});

export const AssetVehicleData = z.object({
  label: z.string(),
  make: z.string(),
  model: z.string(),
  year: z.number().int().optional(),
  vin: z.string().optional(),
});

export const AssetEquipmentData = z.object({
  label: z.string(),
  category: z.string(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  installedOn: z.string().date().optional(),
});

export const AssetMembershipData = z.object({
  label: z.string(),
  organization: z.string(),
  memberSince: z.string().date().optional(),
  status: z.string().optional(),
});

export const AssetPetData = z.object({
  name: z.string(),
  species: z.string(),
  breed: z.string().optional(),
  dateOfBirth: z.string().date().optional(),
});

// Document extraction proposal — attached inline on the document
// node so it survives across page loads. When the upload route runs
// the LLM extractor, the proposed fields are stamped here (never
// applied to `data.*` fields automatically — the auto-move only
// changes the graph type, not free-text metadata). The console
// renders a review card off this shape; POST .../extraction/resolve
// merges the accepted subset into `data` and clears this field.
export const DocumentExtractionProposal = z.object({
  provider: z.enum(["anthropic", "mock"]),
  reason: z.string().optional(),
  proposed: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const DocumentData = z.object({
  title: z.string(),
  category: z.enum(["identity", "legal", "policy", "record", "receipt", "other"]),
  storedAt: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  notes: z.string().optional(),
  pendingExtraction: DocumentExtractionProposal.optional(),
});

// ═══════════════════════════════════════════════════════════════════
// Concepts — reusable value objects not owned themselves
// ═══════════════════════════════════════════════════════════════════

export const PlaceAddressData = z.object({
  label: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string(),
});

export const PreferenceTravelData = z.object({
  scope: z.enum(["general", "airline", "hotel", "seat", "loyalty"]),
  value: z.record(z.unknown()),
});

export const PreferenceDiningData = z.object({
  scope: z.enum(["dietary", "restaurant", "meeting_spot", "cuisine"]),
  value: z.record(z.unknown()),
});

export const PreferenceCommunicationData = z.object({
  channel: z.enum(["sms", "email", "voice", "app"]).optional(),
  quietHours: z.string().optional(),
  formality: z.enum(["formal", "neutral", "warm"]).optional(),
  notes: z.string().optional(),
});

export const PreferenceVendorData = z.object({
  vendorRef: z.string(),
  serviceType: z.string(),
  notes: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════
// Events — things that happened or are scheduled to happen
// ═══════════════════════════════════════════════════════════════════

export const ObligationAppointmentData = z.object({
  title: z.string(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
});

export const ObligationDeadlineData = z.object({
  title: z.string(),
  dueAt: z.string().datetime(),
  category: z.enum(["school", "tax", "renewal", "professional", "personal", "other"]),
  notes: z.string().optional(),
});

export const ObligationRecurringData = z.object({
  title: z.string(),
  cadence: z.string(),
  nextDueAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

export const ObligationEventData = z.object({
  title: z.string(),
  eventDate: z.string().date(),
  category: z.enum(["birthday", "anniversary", "milestone", "other"]),
});

// ═══════════════════════════════════════════════════════════════════
// Transactions — ledgered actions (graph-side projection; full
// ledger lives in the actions table)
// ═══════════════════════════════════════════════════════════════════

export const ActionNodeData = z.object({
  actionId: z.string(),
  summary: z.string(),
  outcome: z.enum(["succeeded", "failed_transient", "failed_permanent", "rolled_back"]),
});

// ═══════════════════════════════════════════════════════════════════
// Ontology — the discriminated union + category metadata
// ═══════════════════════════════════════════════════════════════════

export const NODE_CATEGORIES = [
  "participant",
  "asset",
  "concept",
  "event",
  "transaction",
] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

// Every registered node type carries its category alongside its
// schema. Categories are the phase-0 Accord Project alignment: they
// let generic surfaces (e.g. GET assets, GET participants) enumerate
// without hand-rolled mappings, and they're what the CTO exporter
// keys off of to decide `concept` vs `asset` vs `participant`.
interface NodeTypeSpec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly category: NodeCategory;
  readonly schema: S;
}

const spec = <S extends z.ZodTypeAny>(
  category: NodeCategory,
  schema: S,
): NodeTypeSpec<S> => ({ category, schema });

export const NODE_TYPE_SPECS = {
  // Participants
  "person.principal": spec("participant", PersonPrincipalData),
  "person.member": spec("participant", PersonMemberData),
  "person.staff": spec("participant", PersonStaffData),
  "person.contact": spec("participant", PersonContactData),
  "org.employer": spec("participant", OrgData),
  "org.school": spec("participant", OrgData),
  "org.provider.medical": spec("participant", OrgData),
  "org.provider.financial": spec("participant", OrgData),
  "org.provider.insurance": spec("participant", OrgData),
  "org.club": spec("participant", OrgData),
  "org.airline": spec("participant", OrgData),
  "org.hotel_group": spec("participant", OrgData),
  "org.rental": spec("participant", OrgData),
  "org.vendor": spec("participant", OrgData),

  // Assets
  "place.property": spec("asset", PlacePropertyData),
  "asset.vehicle": spec("asset", AssetVehicleData),
  "asset.equipment": spec("asset", AssetEquipmentData),
  "asset.membership": spec("asset", AssetMembershipData),
  "asset.pet": spec("asset", AssetPetData),
  "document.identity": spec("asset", DocumentData),
  "document.legal": spec("asset", DocumentData),
  "document.policy": spec("asset", DocumentData),
  "document.record": spec("asset", DocumentData),
  "document.receipt": spec("asset", DocumentData),

  // Concepts
  "place.address": spec("concept", PlaceAddressData),
  "preference.travel": spec("concept", PreferenceTravelData),
  "preference.dining": spec("concept", PreferenceDiningData),
  "preference.communication": spec("concept", PreferenceCommunicationData),
  "preference.vendor": spec("concept", PreferenceVendorData),

  // Events
  "obligation.appointment": spec("event", ObligationAppointmentData),
  "obligation.deadline": spec("event", ObligationDeadlineData),
  "obligation.recurring": spec("event", ObligationRecurringData),
  "obligation.event": spec("event", ObligationEventData),

  // Transactions
  "action": spec("transaction", ActionNodeData),
} as const;

export type NodeType = keyof typeof NODE_TYPE_SPECS;

export const NODE_TYPES = Object.keys(NODE_TYPE_SPECS) as NodeType[];

// Back-compat convenience: the {type: schema} projection older
// callers used. Prefer NODE_TYPE_SPECS in new code so the category
// is visible at the call site.
export const NodeTypeSchemas = Object.fromEntries(
  (Object.entries(NODE_TYPE_SPECS) as Array<[NodeType, NodeTypeSpec]>).map(
    ([k, v]) => [k, v.schema] as const,
  ),
) as { readonly [K in NodeType]: (typeof NODE_TYPE_SPECS)[K]["schema"] };

export type NodeDataFor<T extends NodeType> = z.infer<
  (typeof NODE_TYPE_SPECS)[T]["schema"]
>;

export const isKnownNodeType = (t: string): t is NodeType =>
  Object.prototype.hasOwnProperty.call(NODE_TYPE_SPECS, t);

export const parseNodeData = (type: NodeType, data: unknown): unknown => {
  const schema = NODE_TYPE_SPECS[type].schema;
  return schema.parse(data);
};

export const nodeCategoryOf = (type: NodeType): NodeCategory =>
  NODE_TYPE_SPECS[type].category;

// Enumerate the node types in a category. Callers that expose a
// generic "all assets" or "all participants" surface should walk
// this rather than hand-listing types.
export const nodeTypesByCategory = (category: NodeCategory): NodeType[] =>
  NODE_TYPES.filter((t) => NODE_TYPE_SPECS[t].category === category);
