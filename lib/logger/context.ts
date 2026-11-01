// path: lib/logger/context.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Request context carried by the logger.
 *
 * FEATURE_LIST section 32 requires that any payment can be traced from a request to a ledger
 * entry. That only works when every line written while serving one request carries the same
 * request id, so the context is ambient: it lives in `AsyncLocalStorage`, survives `await`, a
 * timer and a promise chain, and every log call reads it without being handed it.
 */

export interface RequestContext {
  readonly requestId: string;
  readonly method?: string;
  readonly route?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly ip?: string;
}

/** What a caller supplies; the request id is generated when it is missing or unsafe. */
export interface RequestContextInput {
  readonly requestId?: string;
  readonly method?: string;
  readonly route?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly ip?: string;
}

/**
 * A request id must be short and printable. The alphabet excludes whitespace, quotes, control
 * characters and anything outside ASCII, so an inbound header can never inject structure into
 * a log line or a downstream query.
 */
const requestIdPattern = /^[A-Za-z0-9._-]{8,128}$/u;

const requestIdPrefix = "req_";

/** Context values are ids and paths; a longer one is bounded before it reaches a record. */
const maxContextFieldLength = 256;

const storage = new AsyncLocalStorage<RequestContext>();

/** True when the value may be used as a request id without further treatment. */
export function isSafeRequestId(value: unknown): value is string {
  return typeof value === "string" && requestIdPattern.test(value);
}

/** A new request id, prefixed so a reader can tell it apart from a provider's identifier. */
export function createRequestId(): string {
  return `${requestIdPrefix}${randomUUID()}`;
}

/**
 * Turns an inbound header value into a usable request id.
 *
 * A value that fails the alphabet is replaced rather than rejected: tracing must keep working
 * even when a proxy or a client sends something unusable.
 */
export function resolveRequestId(candidate: unknown): string {
  return isSafeRequestId(candidate) ? candidate : createRequestId();
}

/**
 * Runs `run` with a request context bound to the current asynchronous execution.
 *
 * A nested call keeps the outer request id unless it names one, which is what a background job
 * started from a request needs: the job inherits the trail that caused it.
 */
export function runWithRequestContext<TResult>(
  input: RequestContextInput,
  run: () => TResult,
): TResult {
  const inherited = storage.getStore();
  const requestId =
    input.requestId === undefined
      ? (inherited?.requestId ?? createRequestId())
      : resolveRequestId(input.requestId);

  return storage.run(buildContext(requestId, input, inherited), run);
}

/** The context of the request being served, or undefined outside a request. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

function buildContext(
  requestId: string,
  input: RequestContextInput,
  inherited: RequestContext | undefined,
): RequestContext {
  const context: {
    requestId: string;
    method?: string;
    route?: string;
    tenantId?: string;
    userId?: string;
    ip?: string;
  } = { requestId };

  assignIfPresent(context, "method", input.method ?? inherited?.method);
  assignIfPresent(context, "route", input.route ?? inherited?.route);
  assignIfPresent(context, "tenantId", input.tenantId ?? inherited?.tenantId);
  assignIfPresent(context, "userId", input.userId ?? inherited?.userId);
  assignIfPresent(context, "ip", input.ip ?? inherited?.ip);

  return context;
}

function assignIfPresent(
  target: { method?: string; route?: string; tenantId?: string; userId?: string; ip?: string },
  key: "method" | "route" | "tenantId" | "userId" | "ip",
  value: string | undefined,
): void {
  if (value === undefined || value.length === 0) {
    return;
  }

  target[key] = value.slice(0, maxContextFieldLength);
}
