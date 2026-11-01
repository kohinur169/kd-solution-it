// path: lib/auth/failures.ts
import { AppError } from "../errors/app-error.ts";
import type { AuthAnswer } from "./http.ts";
import type { AuthFailure } from "./types.ts";

/**
 * Upstream answers translated into the platform's own failure vocabulary.
 *
 * This file exists because of one sentence in FEATURE_LIST section 22: an error message never
 * reveals whether an account exists. Supabase Auth answers a wrong password with
 * `invalid_credentials`, an unknown address with `user_not_found` on some endpoints and an
 * unconfirmed account with `email_not_confirmed`; three different strings, each of which tells
 * an attacker something. This module collapses all of them into one kind - `rejected` - and one
 * catalogue code - `AUTHENTICATION_REQUIRED` - so the response is identical whatever happened.
 *
 * The upstream code is kept on the failure for the structured log, where it is useful, and never
 * for a response or an exception message, where it would be the leak this file prevents. It is
 * accepted only when it looks like a code (`[A-Za-z0-9_.-]`, at most 64 characters), because the
 * body of a remote answer is attacker influenced text.
 */

/** The largest upstream code this module will keep. A sentence is not a code. */
const maximumCodeLength = 64;

const codePattern = /^[A-Za-z0-9_.-]{1,64}$/u;

/** Delay assumed when an upstream rate limit carries no usable `retry-after`. */
export const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 60;

const upstreamCodeFields = ["code", "error_code", "error"] as const;

function readStringField(source: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = source[field];

  return typeof value === "string" && value.length <= maximumCodeLength ? value : null;
}

/**
 * The machine readable code of an upstream error body, or null.
 *
 * The three fields are the ones Supabase uses across the Auth endpoints. The first one that is
 * shaped like a code wins, so an answer that carries both `code` and a long `msg` keeps only the
 * code.
 */
export function readUpstreamCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const record = body as Readonly<Record<string, unknown>>;

  for (const field of upstreamCodeFields) {
    const candidate = readStringField(record, field);

    if (candidate !== null && codePattern.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Classify one upstream answer.
 *
 * A success is `null`; everything else is a failure. The mapping is deliberately coarse:
 *
 *   - `429` is a rate limit, and the caller may retry after the named delay;
 *   - `5xx` is the provider's problem, so the answer is `upstream` and the platform answers 502;
 *   - every other non-success status is a rejection of the request: credentials, a token, a
 *     payload. The caller decides the status code that goes back to the browser;
 *   - a status the platform does not expect from an Auth endpoint is `upstream`, because it means
 *     the project is not the one this code was written against.
 */
export function classifyAuthAnswer(answer: AuthAnswer): AuthFailure | null {
  const { status } = answer;

  if (status >= 200 && status < 300) {
    return null;
  }

  const code = readUpstreamCode(answer.body);

  if (status === 429) {
    return {
      kind: "rate-limited",
      status,
      code,
      retryAfterSeconds:
        answer.retryAfterSeconds === null || answer.retryAfterSeconds <= 0
          ? DEFAULT_RATE_LIMIT_RETRY_SECONDS
          : answer.retryAfterSeconds,
    };
  }

  if (status >= 500) {
    return { kind: "upstream", status, code, retryAfterSeconds: null };
  }

  const isRejection =
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 406 ||
    status === 409 ||
    status === 422;

  if (isRejection) {
    return { kind: "rejected", status, code, retryAfterSeconds: null };
  }

  return { kind: "upstream", status, code, retryAfterSeconds: null };
}

/** What the failure is about: an existing session, or a request that would create one. */
export type AuthErrorContext = "session" | "registration";

/**
 * Map a failure onto a catalogue code.
 *
 * Nothing is invented here: the five codes this function can return were declared by STEP 008
 * and each already has a sentence a person can act on. A rejection is the one place the mapping
 * depends on the context, and the reasoning is worth keeping:
 *
 *   - for a session, the request needed a valid identity, so `AUTHENTICATION_REQUIRED` (401);
 *   - for a registration, the input was not acceptable, so `VALIDATION_FAILED` (422). A
 *     duplicate address and a malformed one answer identically, which is the same
 *     non-disclosure rule seen from the other side.
 */
export function toAuthAppError(failure: AuthFailure, context: AuthErrorContext = "session"): AppError {
  switch (failure.kind) {
    case "timeout":
      return new AppError("TIMEOUT");
    case "network":
    case "upstream":
    case "malformed-response":
      return new AppError("DEPENDENCY_FAILED");
    case "rate-limited":
      return failure.retryAfterSeconds === null
        ? new AppError("RATE_LIMITED")
        : new AppError("RATE_LIMITED", { retryAfterSeconds: failure.retryAfterSeconds });
    case "rejected":
      return context === "registration"
        ? new AppError("VALIDATION_FAILED")
        : new AppError("AUTHENTICATION_REQUIRED");
  }
}

/**
 * The answer to a failed sign in, whatever the upstream reason was.
 *
 * STEP 039 calls this for a wrong password, an unknown address, an unconfirmed address and a
 * disabled account alike. Having one function is the mechanism: a later handler cannot
 * accidentally build a more specific sentence, because there is no other function to call.
 */
export function credentialRejectionError(): AppError {
  return new AppError("AUTHENTICATION_REQUIRED");
}
