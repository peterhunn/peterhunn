import { describe, it, expect } from "vitest";
import {
  NODE_TYPE_SPECS,
  NODE_TYPES,
  NODE_CATEGORIES,
  nodeCategoryOf,
  nodeTypesByCategory,
  type NodeCategory,
} from "../src/entities.js";

describe("ontology categories", () => {
  it("every registered node type has a valid category", () => {
    for (const t of NODE_TYPES) {
      const cat = NODE_TYPE_SPECS[t].category;
      expect(NODE_CATEGORIES).toContain(cat);
    }
  });

  it("nodeCategoryOf matches NODE_TYPE_SPECS", () => {
    for (const t of NODE_TYPES) {
      expect(nodeCategoryOf(t)).toBe(NODE_TYPE_SPECS[t].category);
    }
  });

  it("nodeTypesByCategory partitions the registry cleanly", () => {
    const seen = new Set<string>();
    for (const cat of NODE_CATEGORIES as readonly NodeCategory[]) {
      for (const t of nodeTypesByCategory(cat)) {
        expect(seen.has(t)).toBe(false);
        seen.add(t);
      }
    }
    expect(seen.size).toBe(NODE_TYPES.length);
  });

  it("Accord-aligned buckets carry the expected types", () => {
    expect(nodeTypesByCategory("participant")).toContain("person.principal");
    expect(nodeTypesByCategory("participant")).toContain("org.school");
    expect(nodeTypesByCategory("asset")).toContain("place.property");
    expect(nodeTypesByCategory("asset")).toContain("asset.vehicle");
    expect(nodeTypesByCategory("asset")).toContain("document.identity");
    expect(nodeTypesByCategory("concept")).toContain("place.address");
    expect(nodeTypesByCategory("concept")).toContain("preference.travel");
    expect(nodeTypesByCategory("event")).toContain("obligation.appointment");
    expect(nodeTypesByCategory("transaction")).toContain("action");
  });
});
