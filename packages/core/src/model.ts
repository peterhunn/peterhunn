import type { ContractData } from "./types.js";

/**
 * A typed contract data model — the TypeScript equivalent of a Concerto .cto file.
 *
 * Concerto uses: namespace org.accordproject.nda  /  concept NDAContract { ... }
 * We use:        TypeScript interface + ContractModel metadata
 *
 * The "$class" field on ContractData preserves Concerto namespace interop.
 */
export interface ContractModelMeta {
  namespace: string;   // e.g. "org.accordproject.nda"
  name: string;        // e.g. "NDAContract"
  version: string;     // semver
  description?: string;
}

export interface ContractModel<T extends ContractData> {
  meta: ContractModelMeta;
  /** Runtime type guard — validates that an unknown value matches T. */
  is(data: unknown): data is T;
  /** Serialize contract data to JSON string. */
  serialize(data: T): string;
  /** Deserialize and validate JSON string to T. Throws on invalid input. */
  deserialize(json: string): T;
}

/**
 * Creates a ContractModel from metadata and a validator function.
 *
 * In production, validators are typically generated from Concerto .cto files
 * or defined with Zod schemas. For the SDK core we keep this generic.
 */
export function defineModel<T extends ContractData>(
  meta: ContractModelMeta,
  validator: (data: unknown) => data is T,
): ContractModel<T> {
  return {
    meta,
    is: validator,
    serialize(data) {
      return JSON.stringify(data, null, 2);
    },
    deserialize(json) {
      const parsed: unknown = JSON.parse(json);
      if (!validator(parsed)) {
        throw new Error(
          `Invalid contract data for ${meta.namespace}.${meta.name}`,
        );
      }
      return parsed;
    },
  };
}
