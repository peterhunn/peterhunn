import type { ContractData } from "./types.js";
import type { ContractModel } from "./model.js";

/**
 * A contract template — the TypeScript equivalent of a Cicero .cta template.
 *
 * Cicero templates are Markdown files with {{variable}} placeholders backed
 * by a Concerto model. This interface mirrors that structure:
 *   - `text` is the Markdown template string
 *   - `draft` renders the template with contract data (data → text)
 *   - `parse` extracts variable values from a contract text (text → partial data)
 *
 * The reference implementation uses a lightweight Handlebars-style renderer.
 * A full Cicero adapter is available separately for production use.
 */
export interface ContractTemplate<T extends ContractData> {
  model: ContractModel<T>;
  /** Markdown template with {{dotted.path}} variable placeholders. */
  text: string;
  /** Render contract text from structured data. */
  draft(data: T): string;
  /** Extract variable values found in a contract text. Returns partial data. */
  parse(text: string): Partial<T>;
  /** Return all variable paths referenced in the template. */
  variables(): string[];
}

/**
 * Creates a ContractTemplate backed by a simple Handlebars-style renderer.
 *
 * Variables use {{dotted.path}} syntax matching Cicero conventions.
 * Nested access (e.g. {{disclosingParty.name}}) is supported.
 */
export function defineTemplate<T extends ContractData>(
  model: ContractModel<T>,
  text: string,
): ContractTemplate<T> {
  return {
    model,
    text,

    draft(data) {
      return text.replace(/\{\{([\w.]+)\}\}/g, (match, path: string) => {
        const value = resolvePath(data, path);
        return value !== undefined ? String(value) : match;
      });
    },

    parse(contractText) {
      const vars = extractVariables(text);
      const result: Record<string, unknown> = {};
      for (const varPath of vars) {
        const pattern = buildExtractionPattern(text, varPath);
        const match = pattern ? contractText.match(pattern) : null;
        if (match?.[1]) {
          setPath(result, varPath, match[1].trim());
        }
      }
      return result as Partial<T>;
    },

    variables() {
      return extractVariables(text);
    },
  };
}

function extractVariables(tmpl: string): string[] {
  const matches = [...tmpl.matchAll(/\{\{([\w.]+)\}\}/g)];
  return [...new Set(matches.map((m) => m[1] as string))];
}

function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string;
    if (!(key in cursor) || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1] as string;
  cursor[lastKey] = value;
}

/**
 * Builds a regex that captures the value of a specific {{variable}} by using
 * the surrounding literal text in the template as anchors.
 * This is heuristic — a production implementation would use a proper parser.
 */
function buildExtractionPattern(tmpl: string, varPath: string): RegExp | null {
  const placeholder = `{{${varPath}}}`;
  const idx = tmpl.indexOf(placeholder);
  if (idx === -1) return null;

  const before = tmpl.slice(Math.max(0, idx - 40), idx);
  const after = tmpl.slice(idx + placeholder.length, idx + placeholder.length + 40);

  const anchor = before.split(/\s+/).slice(-3).map(escapeRegex).join("\\s+");
  const tail = after.split(/\s+/).slice(0, 3).map(escapeRegex).join("\\s+");

  try {
    return new RegExp(`${anchor}\\s*([^\\n]+?)\\s*${tail}`);
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
