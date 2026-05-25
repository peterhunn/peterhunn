/**
 * renderTemplate — replace {{slotName}} placeholders with values.
 *
 * Unresolved slots are left as-is so the output still shows the slot name.
 * Used by AgentContractServer to produce a rendered document for LLM review.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? (variables[key] ?? match) : match,
  );
}
