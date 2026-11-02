// path: lib/logger/serialize.ts

/**
 * Turns an arbitrary value into plain JSON data, with hard limits.
 *
 * Log calls receive whatever the caller has at hand: a request body, a provider response, an
 * `Error`, a database row, a class instance. Three things must be true before that reaches a
 * sink:
 *
 *   - it must be JSON serializable, because a record is one JSON line;
 *   - it must be finite, because one log call must never write an unbounded amount of text;
 *   - it must never throw, because a failure while describing a request must not fail the
 *     request.
 *
 * Anything that cannot be represented is replaced by a readable marker such as `[circular]`,
 * and a value that hit a limit sets `truncated` on the result so the record can say so.
 */

export interface SerializationLimits {
  readonly maxDepth: number;
  readonly maxArrayItems: number;
  readonly maxObjectKeys: number;
  readonly maxStringLength: number;
}

export const DEFAULT_SERIALIZATION_LIMITS: SerializationLimits = {
  maxDepth: 6,
  maxArrayItems: 50,
  maxObjectKeys: 50,
  maxStringLength: 2000,
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SerializedValue {
  readonly value: JsonValue;
  readonly truncated: boolean;
}

interface NormalizationState {
  truncated: boolean;
  readonly limits: SerializationLimits;
  readonly ancestors: Set<object>;
}

const circularMarker = "[circular]";
const depthMarker = "[depth limit]";
const functionMarker = "[function]";
const symbolFallbackMarker = "[symbol]";

function marker(state: NormalizationState, text: string): JsonValue {
  state.truncated = true;
  return text;
}

function normalizeString(value: string, state: NormalizationState): JsonValue {
  if (value.length <= state.limits.maxStringLength) {
    return value;
  }

  const omitted = value.length - state.limits.maxStringLength;

  return marker(state, `${value.slice(0, state.limits.maxStringLength)}...[+${omitted} chars]`);
}

function normalizeNumber(value: number): JsonValue {
  if (Number.isFinite(value)) {
    return value;
  }

  if (Number.isNaN(value)) {
    return "NaN";
  }

  return value > 0 ? "Infinity" : "-Infinity";
}

function normalizeError(error: Error, state: NormalizationState, depth: number): JsonValue {
  const shape: Record<string, JsonValue> = {
    name: typeof error.name === "string" ? error.name : "Error",
    message: normalizeString(
      typeof error.message === "string" ? error.message : "",
      state,
    ),
  };

  if (typeof error.stack === "string" && error.stack.length > 0) {
    shape["stack"] = normalizeString(error.stack, state);
  }

  // The standard cause chain is the most useful part of a wrapped error, so it is kept one
  // level at a time until the depth limit stops it like any other nested value.
  if (depth < state.limits.maxDepth && error.cause !== undefined) {
    shape["cause"] = normalize(error.cause, state, depth + 1);
  }

  return shape;
}

function normalizeArray(value: readonly unknown[], state: NormalizationState, depth: number): JsonValue {
  const limit = state.limits.maxArrayItems;
  const items: JsonValue[] = [];

  for (const [index, item] of value.entries()) {
    if (index >= limit) {
      // Every remaining item is accounted for, so the reader can tell how much was dropped.
      items.push(marker(state, `[${value.length - limit} more items]`));
      break;
    }

    items.push(normalize(item, state, depth + 1));
  }

  return items;
}

function normalizeObject(
  value: object,
  state: NormalizationState,
  depth: number,
): JsonValue {
  if (state.ancestors.has(value)) {
    return marker(state, circularMarker);
  }

  state.ancestors.add(value);

  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    }

    if (value instanceof Error) {
      return normalizeError(value, state, depth);
    }

    if (value instanceof Map) {
      return normalizeMap(value, state, depth);
    }

    if (value instanceof Set) {
      return normalizeArray([...value], state, depth);
    }

    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      return normalize((toJson as () => unknown).call(value), state, depth + 1);
    }

    return normalizePlainObject(value, state, depth);
  } finally {
    state.ancestors.delete(value);
  }
}

function normalizeMap(value: Map<unknown, unknown>, state: NormalizationState, depth: number): JsonValue {
  const entries: [string, unknown][] = [];

  for (const [key, item] of value.entries()) {
    entries.push([typeof key === "string" ? key : String(key), item]);
  }

  return normalizePlainObject(Object.fromEntries(entries), state, depth);
}

function normalizePlainObject(
  value: object,
  state: NormalizationState,
  depth: number,
): JsonValue {
  const keys = Object.keys(value);
  const shape: Record<string, JsonValue> = {};

  for (const [index, key] of keys.entries()) {
    if (index >= state.limits.maxObjectKeys) {
      shape["[truncated]"] = `[${keys.length - state.limits.maxObjectKeys} more keys]`;
      break;
    }

    // noPropertyAccessFromIndexSignature is on, so the boundary read is explicit.
    const child = (value as Record<string, unknown>)[key];

    // An undefined field is absent, not null: a record should not spend bytes saying nothing.
    if (child === undefined) {
      continue;
    }

    shape[key] = normalize(child, state, depth + 1);
  }

  return shape;
}

function normalize(value: unknown, state: NormalizationState, depth: number): JsonValue {
  switch (typeof value) {
    case "string":
      return normalizeString(value, state);
    case "number":
      return normalizeNumber(value);
    case "boolean":
      return value;
    case "bigint":
      return `${value.toString()}n`;
    case "undefined":
      return null;
    case "function":
      return marker(state, functionMarker);
    case "symbol":
      return marker(state, value.description === undefined ? symbolFallbackMarker : `[symbol: ${value.description}]`);
    default:
      break;
  }

  if (value === null) {
    return null;
  }

  if (depth >= state.limits.maxDepth) {
    return marker(state, depthMarker);
  }

  if (Array.isArray(value)) {
    return normalizeArray(value, state, depth);
  }

  return normalizeObject(value as object, state, depth);
}

/**
 * Converts a value into JSON safe data and reports whether a limit was hit.
 *
 * Never throws: a value that defeats the normalizer is replaced by a marker.
 */
export function serializeValue(
  value: unknown,
  limits: SerializationLimits = DEFAULT_SERIALIZATION_LIMITS,
): SerializedValue {
  const state: NormalizationState = { truncated: false, limits, ancestors: new Set() };

  try {
    return { value: normalize(value, state, 0), truncated: state.truncated };
  } catch {
    return { value: "[unserializable value]", truncated: true };
  }
}
