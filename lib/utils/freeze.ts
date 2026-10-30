// path: lib/utils/freeze.ts

/**
 * Freezes a value and every nested object it owns.
 *
 * Configuration is shared by many later modules, so a single accidental write must fail
 * immediately instead of silently changing behaviour for the rest of the process. Object
 * .freeze is shallow, which is exactly the trap this helper exists to avoid.
 */
export function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  Object.freeze(value);

  // Object.values needs an indexable view; the cast is the single boundary of this generic
  // helper and never leaves it.
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }

  return value;
}
