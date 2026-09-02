import { z } from "zod";

// Edge (relationship) types. Directional and versioned. Attributes on
// edges are typed per relationship. See docs/22-knowledge-graph.md
// §"Core relationship types".

export const EdgeType = z.enum([
  // person → person
  "has_spouse",
  "parent_of",
  "sibling_of",
  "guardian_of",

  // person → org
  "works_at",
  "attends",
  "member_of",
  "advised_by",

  // person → asset
  "owns",
  "uses",

  // person → preference
  "prefers",

  // person → obligation
  "assigned_to",
  "covers",

  // place → asset
  "contains",

  // place → org (vendor)
  "serviced_by",

  // asset → obligation
  "requires",

  // document → any
  "documents",
  "insures",

  // action → any
  "performed_for",
  "authorized_by",
  "affected",
]);
export type EdgeType = z.infer<typeof EdgeType>;

// Free-form attribute payload; per-edge-type refinements can be added
// as this matures. For Phase 0 the attribute bag is intentionally
// permissive so the graph can accept early real-world data without
// blocking on schema.
export const EdgeAttrs = z.record(z.unknown());
export type EdgeAttrs = z.infer<typeof EdgeAttrs>;
