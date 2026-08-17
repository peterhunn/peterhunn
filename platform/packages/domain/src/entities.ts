import { z } from "zod";

// Life Graph node data schemas, keyed by the fully-qualified entity type.
// The graph stores {type, data} pairs; here we constrain the shape of
// `data` for each supported `type`. New entity types are added to the
// ontology by extending this file and the discriminated union at the
// bottom — see ../life-management/knowledge-graph.md §"Ontology
// governance".

// ─── People ─────────────────────────────────────────────────────

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

// ─── Organizations ──────────────────────────────────────────────

export const OrgData = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

// ─── Places ─────────────────────────────────────────────────────

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

export const PlaceAddressData = z.object({
  label: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string(),
});

// ─── Assets ─────────────────────────────────────────────────────

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

// ─── Obligations ────────────────────────────────────────────────

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

// ─── Preferences ────────────────────────────────────────────────

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

// ─── Documents ──────────────────────────────────────────────────

export const DocumentData = z.object({
  title: z.string(),
  category: z.enum(["identity", "legal", "policy", "record", "receipt", "other"]),
  storedAt: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

// ─── Actions and history ────────────────────────────────────────

// action / interaction / decision nodes represent history that agents
// and managers write. The full action ledger has its own table for
// audit + querying performance — this node type is the graph-side
// projection.
export const ActionNodeData = z.object({
  actionId: z.string(),
  summary: z.string(),
  outcome: z.enum(["succeeded", "failed_transient", "failed_permanent", "rolled_back"]),
});

// ─── Ontology — the discriminated union ─────────────────────────

export const NodeTypeSchemas = {
  "person.principal": PersonPrincipalData,
  "person.member": PersonMemberData,
  "person.staff": PersonStaffData,
  "person.contact": PersonContactData,

  "org.employer": OrgData,
  "org.school": OrgData,
  "org.provider.medical": OrgData,
  "org.provider.financial": OrgData,
  "org.provider.insurance": OrgData,
  "org.club": OrgData,
  "org.airline": OrgData,
  "org.hotel_group": OrgData,
  "org.rental": OrgData,
  "org.vendor": OrgData,

  "place.property": PlacePropertyData,
  "place.address": PlaceAddressData,

  "asset.vehicle": AssetVehicleData,
  "asset.equipment": AssetEquipmentData,
  "asset.membership": AssetMembershipData,
  "asset.pet": AssetPetData,

  "obligation.appointment": ObligationAppointmentData,
  "obligation.deadline": ObligationDeadlineData,
  "obligation.recurring": ObligationRecurringData,
  "obligation.event": ObligationEventData,

  "preference.travel": PreferenceTravelData,
  "preference.dining": PreferenceDiningData,
  "preference.communication": PreferenceCommunicationData,
  "preference.vendor": PreferenceVendorData,

  "document.identity": DocumentData,
  "document.legal": DocumentData,
  "document.policy": DocumentData,
  "document.record": DocumentData,
  "document.receipt": DocumentData,

  "action": ActionNodeData,
} as const;

export type NodeType = keyof typeof NodeTypeSchemas;

export const NODE_TYPES = Object.keys(NodeTypeSchemas) as NodeType[];

export type NodeDataFor<T extends NodeType> = z.infer<
  (typeof NodeTypeSchemas)[T]
>;

export const isKnownNodeType = (t: string): t is NodeType =>
  Object.prototype.hasOwnProperty.call(NodeTypeSchemas, t);

export const parseNodeData = (type: NodeType, data: unknown): unknown => {
  const schema = NodeTypeSchemas[type];
  return schema.parse(data);
};
