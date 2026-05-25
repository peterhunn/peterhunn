/**
 * Clause editing utilities for free-form document negotiation.
 *
 * Documents mark negotiable clauses with HTML comment delimiters:
 *   <!-- clause:id -->current text<!-- /clause:id -->
 *
 * These markers are invisible in rendered Markdown and HTML, and
 * survive round-trips through most document formats.
 */

const CLAUSE_RE = /<!-- clause:([\w-]+) -->([\s\S]*?)<!-- \/clause:\1 -->/g;

/**
 * Extract all clause blocks from a document.
 * Returns a map of clause id → current text.
 */
export function extractClauses(document: string): Record<string, string> {
  const clauses: Record<string, string> = {};
  for (const match of document.matchAll(CLAUSE_RE)) {
    const id = match[1];
    const text = match[2];
    if (id !== undefined && text !== undefined) {
      clauses[id] = text.trim();
    }
  }
  return clauses;
}

/**
 * Apply proposed clause edits to a document, replacing marker content.
 * Unknown clause ids (not present in document) are ignored.
 * Returns the modified document text.
 */
export function applyClauseEdits(
  document: string,
  edits: Record<string, string>,
): string {
  return document.replace(CLAUSE_RE, (match, id: string, _current: string) => {
    if (Object.prototype.hasOwnProperty.call(edits, id)) {
      const replacement = edits[id] ?? _current;
      return `<!-- clause:${id} -->\n${replacement}\n<!-- /clause:${id} -->`;
    }
    return match;
  });
}

/**
 * Apply clause edits and compute the SHA-256 hash of the result.
 * Returns both the modified document and its hex hash.
 */
export async function applyAndHash(
  document: string,
  edits: Record<string, string>,
): Promise<{ document: string; hash: string }> {
  const modified = applyClauseEdits(document, edits);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(modified));
  const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { document: modified, hash };
}
