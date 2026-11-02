// path: lib/errors/codes.ts
import type { MessagePath } from "../i18n/messages.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The error code catalog: the single source of truth for every failure an API can report.
 *
 * A code is a public identifier. A store integration, a mobile client or a background job will
 * branch on it, so a code is never renamed after release and a new situation gets a new code
 * rather than a new meaning for an old one.
 *
 * Each entry carries the three facts a response needs:
 *
 *   - `status`, the HTTP status code;
 *   - `messageKey`, a key in the English catalog, so the sentence a merchant reads is writable
 *     and translatable and can never be a string assembled at the failure site;
 *   - `retryable`, whether the caller may succeed by trying again, which a job or a client can
 *     act on without parsing English.
 *
 * Adding a code means adding one entry here and one message to `lib/i18n/strings/en.ts`. The
 * type of `messageKey` is the catalog path type, so a missing key is a compile error.
 */

export interface ErrorDefinition {
  readonly status: number;
  readonly messageKey: MessagePath;
  readonly retryable: boolean;
}

export const ERROR_CODES = deepFreeze({
  VALIDATION_FAILED: {
    status: 422,
    messageKey: "errors.validationFailed",
    retryable: false,
  },
  AUTHENTICATION_REQUIRED: {
    status: 401,
    messageKey: "errors.authenticationRequired",
    retryable: false,
  },
  PERMISSION_DENIED: {
    status: 403,
    messageKey: "errors.permissionDenied",
    retryable: false,
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    messageKey: "errors.resourceNotFound",
    retryable: false,
  },
  METHOD_NOT_ALLOWED: {
    status: 405,
    messageKey: "errors.methodNotAllowed",
    retryable: false,
  },
  CONFLICT: {
    status: 409,
    messageKey: "errors.conflict",
    retryable: false,
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    messageKey: "errors.idempotencyConflict",
    retryable: false,
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    messageKey: "errors.payloadTooLarge",
    retryable: false,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    messageKey: "errors.unsupportedMediaType",
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    messageKey: "errors.rateLimited",
    retryable: true,
  },
  ACCOUNT_LOCKED: {
    status: 423,
    messageKey: "errors.accountLocked",
    retryable: true,
  },
  INTERNAL_ERROR: {
    status: 500,
    messageKey: "errors.internal",
    retryable: false,
  },
  DEPENDENCY_FAILED: {
    status: 502,
    messageKey: "errors.dependencyFailed",
    retryable: true,
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    messageKey: "errors.serviceUnavailable",
    retryable: true,
  },
  TIMEOUT: {
    status: 504,
    messageKey: "errors.timeout",
    retryable: true,
  },
} satisfies Record<string, ErrorDefinition>);

export type ErrorCode = keyof typeof ERROR_CODES;

/** Every code, in declaration order. Used by the gate and by documentation. */
export const ERROR_CODE_NAMES = Object.keys(ERROR_CODES) as readonly ErrorCode[];

/** True when a value is a code in the catalog. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

/** The definition of a known code. */
export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CODES[code];
}

/**
 * The code an unexpected failure is reported as. Every unknown throw ends here, so a caller
 * never sees an internal message, and monitoring can alert on one value.
 */
export const INTERNAL_ERROR_CODE: ErrorCode = "INTERNAL_ERROR";
