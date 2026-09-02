import { z, type ZodTypeAny } from "zod";
import {
  NODE_TYPE_SPECS,
  NODE_TYPES,
  nodeCategoryOf,
  type NodeCategory,
  type NodeType,
} from "./entities.js";

// One-way exporter: walks the Zod schemas registered in
// NODE_TYPE_SPECS and emits an Accord Project Concerto namespace
// (.cto) file. Zod stays the runtime authority in the codebase; CTO
// is a distribution artifact for consumers that live outside our
// Node runtime — a Swift/Kotlin mobile app, a Solidity smart
// contract, a Java partner service, an Accord smart-legal-contract
// template. If that need never materializes, this exporter has cost
// nothing at runtime; it's build-only.
//
// Supported Zod features:
//   z.string() [.email/.url/.date/.datetime] → String / DateTime
//   z.number().int()                          → Integer
//   z.number()                                → Double
//   z.boolean()                               → Boolean
//   z.enum([...])                             → named enum declaration
//   z.array(x)                                → x[]
//   z.object({...})                           → concept
//   .optional()                               → `optional` modifier
//
// Anything else (unions, records, refinements) becomes String with
// a `// unmapped: <shape>` comment so the exporter never silently
// drops fidelity.

const NAMESPACE = "com.atelier@0.1.0";

const CATEGORY_TO_KEYWORD: Record<NodeCategory, string> = {
  participant: "participant",
  asset: "asset",
  concept: "concept",
  event: "event",
  transaction: "transaction",
};

// Slug-to-PascalCase: "person.principal" → "PersonPrincipal",
// "org.provider.medical" → "OrgProviderMedical".
const classNameFor = (type: NodeType): string =>
  type
    .split(".")
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");

interface DerivedField {
  readonly line: string;
  readonly extraEnums: readonly EnumDecl[];
}
interface EnumDecl {
  readonly name: string;
  readonly values: readonly string[];
}

const asEnumValue = (v: string): string =>
  v
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^([0-9])/, "_$1")
    .toUpperCase();

const enumNameFor = (className: string, fieldName: string): string =>
  `${className}${fieldName.charAt(0).toUpperCase()}${fieldName.slice(1)}`;

// Introspect a Zod leaf into a CTO type token. Returns the token +
// an optional array of ancillary enum declarations to emit before
// the parent class.
const mapField = (
  schema: ZodTypeAny,
  className: string,
  fieldName: string,
): DerivedField => {
  let current: ZodTypeAny = schema;
  let optional = false;
  let isArray = false;
  const enums: EnumDecl[] = [];

  // Unwrap optional / default / nullable wrappers.
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodNullable
  ) {
    if (current instanceof z.ZodOptional) optional = true;
    if (current instanceof z.ZodDefault) optional = true; // has default => not required
    if (current instanceof z.ZodNullable) optional = true;
    current = current._def.innerType as ZodTypeAny;
  }

  if (current instanceof z.ZodArray) {
    isArray = true;
    current = current._def.type as ZodTypeAny;
  }

  const stringModifiers = (s: z.ZodString): string => {
    // Check checks[] for known refinements; Concerto's DateTime
    // covers ISO 8601 for both .datetime() and .date().
    const checks = (s._def.checks ?? []) as Array<{ kind: string }>;
    if (checks.some((c) => c.kind === "datetime")) return "DateTime";
    if (checks.some((c) => c.kind === "date")) return "DateTime";
    return "String";
  };

  let token: string;
  if (current instanceof z.ZodString) {
    token = stringModifiers(current);
  } else if (current instanceof z.ZodNumber) {
    const checks = (current._def.checks ?? []) as Array<{ kind: string }>;
    token = checks.some((c) => c.kind === "int") ? "Integer" : "Double";
  } else if (current instanceof z.ZodBoolean) {
    token = "Boolean";
  } else if (current instanceof z.ZodEnum) {
    const values = current._def.values as string[];
    const name = enumNameFor(className, fieldName);
    enums.push({ name, values });
    token = name;
  } else {
    // Unions, records, tuples, objects nested inline — mark and fall
    // back to String so the exporter never silently drops fidelity.
    const label = (current._def as { typeName?: string })?.typeName ?? "Unknown";
    token = "String";
    return {
      line: `  o String ${fieldName}${optional ? " optional" : ""}   // unmapped: ${label}`,
      extraEnums: [],
    };
  }

  const typeToken = isArray ? `${token}[]` : token;
  return {
    line: `  o ${typeToken} ${fieldName}${optional ? " optional" : ""}`,
    extraEnums: enums,
  };
};

const emitClass = (type: NodeType): string => {
  const spec = NODE_TYPE_SPECS[type];
  const className = classNameFor(type);
  const keyword = CATEGORY_TO_KEYWORD[nodeCategoryOf(type)];

  // Every schema at the top level is a ZodObject. Walk its .shape.
  if (!(spec.schema instanceof z.ZodObject)) {
    return `// ${type}: top-level is not a ZodObject; skipped\n`;
  }
  const shape = spec.schema.shape as Record<string, ZodTypeAny>;

  const enums: EnumDecl[] = [];
  const fieldLines: string[] = [];
  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    const derived = mapField(fieldSchema, className, fieldName);
    fieldLines.push(derived.line);
    enums.push(...derived.extraEnums);
  }

  const enumBlocks = enums
    .map(
      (e) =>
        `enum ${e.name} {\n${e.values
          .map((v) => `  o ${asEnumValue(v)}`)
          .join("\n")}\n}\n`,
    )
    .join("\n");

  const header = `${keyword} ${className} identified by id {\n  o String id\n${fieldLines.join("\n")}\n}\n`;

  return `${enumBlocks ? enumBlocks + "\n" : ""}${header}`;
};

export const generateCto = (): string => {
  const now = new Date().toISOString();
  const header = [
    `// Generated by @atelier/domain cto-export at ${now}`,
    "// Do not edit by hand — regenerate with `pnpm --filter @atelier/domain generate:cto`",
    "// Zod is the runtime authority; this file is a build artifact.",
    "",
    `namespace ${NAMESPACE}`,
    "",
  ].join("\n");

  const byCategory: Record<NodeCategory, string[]> = {
    participant: [],
    asset: [],
    concept: [],
    event: [],
    transaction: [],
  };
  for (const t of NODE_TYPES) {
    byCategory[nodeCategoryOf(t)].push(emitClass(t));
  }

  const sections: string[] = [];
  for (const cat of ["participant", "asset", "concept", "event", "transaction"] as const) {
    if (byCategory[cat].length === 0) continue;
    sections.push(
      `// ──── ${cat}s ${"─".repeat(60 - cat.length)}\n\n${byCategory[cat].join("\n")}`,
    );
  }

  return `${header}\n${sections.join("\n")}`;
};
