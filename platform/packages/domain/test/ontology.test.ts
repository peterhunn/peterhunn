import { describe, it, expect } from "vitest";
import {
  validateNodeCandidate,
  OntologyError,
  nowIso,
  type NodeCandidate,
} from "../src/ontology.js";
import { NODE_TYPES, isKnownNodeType } from "../src/entities.js";

describe("ontology", () => {
  it("lists a non-empty type catalog", () => {
    expect(NODE_TYPES.length).toBeGreaterThan(0);
    expect(isKnownNodeType("person.principal")).toBe(true);
    expect(isKnownNodeType("nope.nope")).toBe(false);
  });

  it("accepts a valid person.principal candidate", () => {
    const c: NodeCandidate = {
      type: "person.principal",
      data: {
        fullName: "Alex Carrington",
        emails: ["alex@example.com"],
        phones: [],
      },
      provenance: {
        source: "customer_direct",
        assertedBy: "mgr_test",
        assertedAt: nowIso(),
        confidence: 1,
        status: "confirmed",
      },
    };
    const parsed = validateNodeCandidate(c);
    expect(parsed.type).toBe("person.principal");
  });

  it("rejects an unknown type", () => {
    const c: NodeCandidate = {
      type: "person.wizard",
      data: {},
      provenance: {
        source: "customer_direct",
        assertedBy: "mgr_test",
        assertedAt: nowIso(),
        confidence: 1,
        status: "confirmed",
      },
    };
    expect(() => validateNodeCandidate(c)).toThrow(OntologyError);
  });

  it("rejects invalid data for a known type", () => {
    const c: NodeCandidate = {
      type: "person.principal",
      data: { fullName: 42 },
      provenance: {
        source: "customer_direct",
        assertedBy: "mgr_test",
        assertedAt: nowIso(),
        confidence: 1,
        status: "confirmed",
      },
    };
    expect(() => validateNodeCandidate(c)).toThrow();
  });
});
