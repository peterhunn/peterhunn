// Drop keys whose value is `undefined`. Needed at every Zod-parse →
// repo-input hand-off because `.optional()` in Zod produces
// `{ k?: T | undefined }` while our repo inputs use
// exactOptionalPropertyTypes (`{ k?: T }`) — the second one forbids
// an explicit undefined slot. Same shape at runtime, different
// contract at the type layer; stripping undefined bridges them.
export const stripUndefined = <T extends object>(
  obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> } => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
};
