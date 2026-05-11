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
export declare function defineTemplate<T extends ContractData>(model: ContractModel<T>, text: string): ContractTemplate<T>;
//# sourceMappingURL=template.d.ts.map