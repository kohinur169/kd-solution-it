// path: lib/errors/respond.ts
import { ZodError } from "zod";
import { getMessage } from "../i18n/messages.ts";
import {
  createRequestId,
  currentRequestContext,
  runWithRequestContext,
} from "../logger/context.ts";
import { logger as defaultLogger, type Logger } from "../logger/logger.ts";
import { AppError, isAppError, toAppError, type ErrorDetail } from "./app-error.ts";
import {
  ERROR_CODES,
  INTERNAL_ERROR_CODE,
  isErrorCode,
  type ErrorCode,
} from "./codes.ts";

/**
 * The global error response format.
 *
 * Every failed API call answers with one JSON envelope:
 *
 * ```json
 * {
 *   "error": {
 *     "code": "VALIDATION_FAILED",
 *     "message": "Some of the information sent could not be accepted. ...",
 *     "requestId": "req_...",
 *     "retryable": false,
 *     "details": [{ "field": "email", "rule": "invalid_format" }]
 *   }
 * }
 * ```
 *
 * The rules this module enforces, in one place, for every route:
 *
 *   - the message comes from the string catalog and states what the client can do, never what
 *     the server saw;
 *   - an unknown failure is `INTERNAL_ERROR` and its text, stack, driver message and cause
 *     never leave the process - only the structured log sees them;
 *   - a rejected value is never echoed, because it can be a password or a card number; a
 *     validation detail carries a field path and a rule name only;
 *   - the request id is returned so a merchant can quote it and an engineer can find the exact
 *     line in the log;
 *   - `retryable` and `retry-after` answer whether and when a retry can succeed;
 *   - the response is never cached, never sniffed and never HTML.
 */

/** One detail of a validation failure. The rejected value is deliberately absent. */
export interface ErrorEnvelopeDetail {
  readonly field: string;
  readonly rule: string;
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
    readonly details?: readonly ErrorEnvelopeDetail[];
    readonly retryAfterSeconds?: number;
  };
}

export interface ErrorResponseOptions {
  /** Injected by the gate so it can inspect what would be written. */
  readonly logger?: Logger;
}

/** A handler in the shape Next.js expects, before the wrapper widens it. */
export type RouteHandler<TArguments extends readonly unknown[]> = (
  request: Request,
  ...arguments_: TArguments
) => Response | Promise<Response>;

const maxDetails = 25;
const maxFieldLength = 120;
const maxRuleLength = 60;

const unknownFieldName = "unknown";
const unknownRuleName = "invalid";
const rootFieldName = "body";

/** A field path built from object keys and array indexes: `items[2].email`. */
const fieldPathPattern =
  /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,6}\])*$/u;

/** A rule name in the shape Zod and this module use: `invalid_format`. */
const ruleNamePattern = /^[a-z][a-z0-9_]{0,59}$/u;

/**
 * Reduces a detail to a field path and a rule name, both matched against a strict alphabet and
 * a length ceiling. Anything else is replaced, never echoed.
 */
export function sanitizeDetails(
  details: readonly ErrorDetail[],
): readonly ErrorEnvelopeDetail[] {
  const sanitized: ErrorEnvelopeDetail[] = [];

  for (const detail of details.slice(0, maxDetails)) {
    const field =
      fieldPathPattern.test(detail.field) && detail.field.length <= maxFieldLength
        ? detail.field
        : unknownFieldName;

    const rule =
      ruleNamePattern.test(detail.rule) && detail.rule.length <= maxRuleLength
        ? detail.rule
        : unknownRuleName;

    sanitized.push({ field, rule });
  }

  return sanitized;
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let formatted = "";

  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }

    const name = typeof segment === "string" ? segment : unknownFieldName;
    formatted += formatted.length === 0 ? name : `.${name}`;
  }

  return formatted.length === 0 ? rootFieldName : formatted;
}

function isZodErrorLike(value: unknown): value is ZodError {
  if (value instanceof ZodError) {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { name?: unknown; issues?: unknown };

  return candidate.name === "ZodError" && Array.isArray(candidate.issues);
}

/** The details of a Zod failure: a path and a rule per issue, with no value and no message. */
function validationDetailsFrom(error: ZodError): readonly ErrorDetail[] {
  return error.issues.slice(0, maxDetails).map((issue) => ({
    field: formatIssuePath(issue.path),
    rule: typeof issue.code === "string" ? issue.code : unknownRuleName,
  }));
}

/**
 * Turns any thrown value into a known failure.
 *
 * A Zod failure becomes `VALIDATION_FAILED`, an `AppError` passes through with its code, and
 * anything else becomes `INTERNAL_ERROR`. This is the only place that decision is made, so a
 * route cannot invent a different one.
 */
export function normalizeError(value: unknown): AppError {
  if (isZodErrorLike(value)) {
    return new AppError("VALIDATION_FAILED", { details: validationDetailsFrom(value) });
  }

  if (isAppError(value)) {
    return value;
  }

  return toAppError(value);
}

/** The request id of the current request, or a new one when there is no context. */
function resolveEnvelopeRequestId(): string {
  return currentRequestContext()?.requestId ?? createRequestId();
}

/** Builds the envelope for an already normalized failure. */
export function buildErrorEnvelope(
  error: AppError,
  requestId: string = resolveEnvelopeRequestId(),
): ErrorEnvelope {
  const code = isErrorCode(error.code) ? error.code : INTERNAL_ERROR_CODE;
  const definition = ERROR_CODES[code];
  const details = code === "VALIDATION_FAILED" ? sanitizeDetails(error.details) : [];
  const retryAfterSeconds = definition.retryable ? error.retryAfterSeconds : undefined;

  const base = {
    code,
    message: getMessage(definition.messageKey),
    requestId,
    retryable: definition.retryable,
  };

  const withDetails = details.length > 0 ? { ...base, details } : base;
  const complete =
    retryAfterSeconds === undefined
      ? withDetails
      : { ...withDetails, retryAfterSeconds };

  return { error: complete };
}

function responseHeaders(requestId: string, retryAfterSeconds: number | undefined): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  };

  if (retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(retryAfterSeconds);
  }

  return headers;
}

/**
 * Writes the one log line a failure produces, then returns the envelope.
 *
 * A server fault is logged at `error` with the original value, so the log keeps the stack and
 * the cause. A client fault is logged at `warn` without a stack: a form validation error is not
 * an incident. Either way there is exactly one line, because the envelope is built once.
 */
function logFailure(
  error: AppError,
  status: number,
  original: unknown,
  log: Logger,
): void {
  if (status >= 500) {
    log.error("request failed", { code: error.code, status, error: original });
    return;
  }

  log.warn("request rejected", { code: error.code, status });
}

/**
 * The HTTP response for a failure. Never throws: a defect while building the envelope is
 * answered with a minimal, machine readable 500 rather than an HTML error page.
 */
export function toErrorResponse(
  thrown: unknown,
  options: ErrorResponseOptions = {},
): Response {
  const log = options.logger ?? defaultLogger;

  try {
    const error = normalizeError(thrown);
    const code = isErrorCode(error.code) ? error.code : INTERNAL_ERROR_CODE;
    const definition = ERROR_CODES[code];
    const requestId = resolveEnvelopeRequestId();
    const status = definition.status;
    const envelope = buildErrorEnvelope(error, requestId);
    const retryAfterSeconds = definition.retryable ? error.retryAfterSeconds : undefined;

    logFailure(error, status, thrown, log);

    return new Response(JSON.stringify(envelope), {
      status,
      headers: responseHeaders(requestId, retryAfterSeconds),
    });
  } catch {
    const requestId = resolveEnvelopeRequestId();

    return new Response(
      JSON.stringify({ error: { code: INTERNAL_ERROR_CODE, requestId } }),
      {
        status: ERROR_CODES[INTERNAL_ERROR_CODE].status,
        headers: responseHeaders(requestId, undefined),
      },
    );
  }
}

/**
 * Wraps a route handler so that every failure leaves through `toErrorResponse`.
 *
 * On success the handler's own response is returned untouched. The wrapper also opens the
 * request context, so a route does not have to: an inbound `x-request-id` is validated and
 * reused, anything else becomes a generated id, and the id appears in the envelope and in
 * every log line written while the handler runs.
 */
export function withErrorResponse<TArguments extends readonly unknown[]>(
  handler: RouteHandler<TArguments>,
  options: ErrorResponseOptions = {},
): (request: Request, ...arguments_: TArguments) => Promise<Response> {
  return async (request: Request, ...arguments_: TArguments): Promise<Response> => {
    const requestId = request.headers.get("x-request-id");
    const context =
      requestId === null
        ? { method: request.method, route: routeOf(request) }
        : { requestId, method: request.method, route: routeOf(request) };

    return runWithRequestContext(context, async (): Promise<Response> => {
      try {
        return await handler(request, ...arguments_);
      } catch (error) {
        return toErrorResponse(error, options);
      }
    });
  };
}

function routeOf(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}
