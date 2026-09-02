import type { Scope, ScopeValue } from "@atelier/domain";

// A policy's scope matches an action if every scope key is present in
// the action attrs AND the attribute's value satisfies the scope
// constraint. If a scope key is absent from the attrs the policy does
// NOT match — the policy is scoped to actions that specify the attribute.
export const scopeMatches = (
  scope: Scope,
  attrs: Record<string, unknown>,
): boolean => {
  for (const [key, constraint] of Object.entries(scope)) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) return false;
    const actual = attrs[key];
    if (!valueSatisfies(constraint, actual)) return false;
  }
  return true;
};

const valueSatisfies = (constraint: ScopeValue, actual: unknown): boolean => {
  if (Array.isArray(constraint)) {
    return constraint.some((c) => scalarEqual(c, actual));
  }
  return scalarEqual(constraint, actual);
};

const scalarEqual = (a: unknown, b: unknown): boolean => a === b;
