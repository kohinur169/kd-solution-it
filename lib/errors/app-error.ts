// path: lib/errors/app-error.ts
import { ERROR_CODES, INTERNAL_ERROR_CODE, isErrorCode, type ErrorCode } from "./codes.ts";

/**
 * A failure the platform understands.
 *
 * The class carries behaviour that is data, not a taxonomy: the code decides the status, the
 * message and whether a retry can help. There is no hierarchy of subclasses, because five class
 * names tell a reader less than one code and one catalog entry.
 *
 * The `message` of the `Error` is the code itself, deliberately. The sentence a client reads
 * comes from the catalog in the response builder; an internal string passed at the throw site
 * can therefore never reach a response by accident.
 */

/** A machine readable reason attached to a validation failure. Never carries the input value. */
export interface ErrorDetail {
  readonly field: string;
  readonly rule: string;
}

export interface AppErrorOptions {
  readonly details?: readonly ErrorDetail[];
  /** Seconds a caller should wait before retrying. Only meaningful for a retryable code. */
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

const minimumRetryAfterSeconds = 1;
const maximumRetryAfterSeconds = 86_400;

function normalizeRetryAfterSeconds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  const seconds = Math.round(value);

  return seconds < minimumRetryAfterSeconds || seconds > maximumRetryAfterSeconds
    ? undefined
    : seconds;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: readonly ErrorDetail[];
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });

    this.name = "AppError";
    this.code = code;
    this.details = options.details ?? [];
    this.retryAfterSeconds = normalizeRetryAfterSeconds(options.retryAfterSeconds);
  }

  get status(): number {
    return ERROR_CODES[this.code].status;
  }

  get retryable(): boolean {
    return ERROR_CODES[this.code].retryable;
  }
}

/** True when the value is an `AppError` carrying a code in the catalog. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError && isErrorCode(value.code);
}

/**
 * Turns any thrown value into an `AppError`.
 *
 * A known failure passes through. Anything else - an `Error`, a string, `null`, an object from
 * a driver - becomes `INTERNAL_ERROR` with the original value kept as `cause`, so the log keeps
 * the evidence while the response says nothing about it.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) {
    return value;
  }

  return new AppError(INTERNAL_ERROR_CODE, { cause: value });
}

/** A validation failure with one detail per rejected field. */
export function validationError(details: readonly ErrorDetail[]): AppError {
  return new AppError("VALIDATION_FAILED", { details });
}

/** A rate limited failure that tells the caller when a retry can succeed. */
export function rateLimited(retryAfterSeconds: number): AppError {
  return new AppError("RATE_LIMITED", { retryAfterSeconds });
}
