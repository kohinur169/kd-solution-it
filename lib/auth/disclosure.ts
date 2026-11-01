// path: lib/auth/disclosure.ts
import { AppError } from "../errors/app-error.ts";
import { ERROR_CODES, type ErrorCode } from "../errors/codes.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * What an anonymous authentication surface is allowed to say.
 *
 * Section 22 of the feature list ends with one sentence - "Error messages never reveal whether an
 * account exists" - and that sentence is a property of a *set* of answers, not of any single one.
 * A route can be careful on its own and still leak, because the leak usually lives in the answer
 * that was added later: the `409` a duplicate signup produced, the `"enrolled": true` a challenge
 * endpoint volunteered, the `"locked"` a stranger could provoke with an address they do not own.
 *
 * This module is the contract those answers are checked against. It holds no logic about signing
 * in: it holds the catalogue of surfaces, the codes each may answer with, the one acceptance body
 * signup sends for every address, and the rule that a validation detail may describe the *form* a
 * merchant submitted but never the *account* behind it.
 *
 * ## Three kinds of answer
 *
 *   - **A refusal a stranger can cause.** Wrong password, unknown address, expired link: one code
 *     (`AUTHENTICATION_REQUIRED`), one sentence from the catalog, no details, no field names. The
 *     sentence is the same one the platform sends to a request with no session at all.
 *   - **An acceptance.** Signup answers one body for every address, because "we sent you a link"
 *     and "that address is registered" are the same fact told twice. A merchant who typed their
 *     own address a second time sees the same sentence as everyone else; the mail that does not
 *     arrive is the only difference, and only they can tell.
 *   - **A fact about the caller's own account.** `ACCOUNT_LOCKED` and the second-factor challenge
 *     are real answers, and they are allowed - but only *after* the password has been proven.
 *     Section 22 line 238 says a locked account with the right password does not sign in, so the
 *     lock answer necessarily exists; line 243 says a stranger cannot learn it. Both hold when the
 *     lock answer is computed only on the far shore of a correct password check.
 *
 * ## Why the catalogue is data
 *
 * `lib/auth/verify.ts` fails the build when a route under `app/api/auth/` is not classified here.
 * A new endpoint therefore cannot ship without someone deciding which column it belongs in, and an
 * endpoint that starts answering `CONFLICT` on an anonymous surface is a red gate rather than a
 * discovery after release.
 */

/** One surface, the codes it may answer, and why that set is the whole set. */
export interface AnonymousSurface {
  /** The path the app router serves, so the gate can match it against the route files. */
  readonly path: string;
  readonly codes: readonly ErrorCode[];
  readonly note: string;
}

/**
 * A session-scoped surface. It is listed so the gate can tell "classified" from "forgotten", and
 * so the answer it gives about a second factor is understood to belong to the person who is
 * already signed in rather than to anyone who can reach the port.
 */
export interface SessionSurface {
  readonly path: string;
  readonly note: string;
}

/** The refusal every anonymous surface sends when the caller has not proven who they are. */
export const ANONYMOUS_REFUSAL: ErrorCode = "AUTHENTICATION_REQUIRED";

/**
 * The codes a stranger-facing surface may answer with.
 *
 * `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PERMISSION_DENIED` and `RESOURCE_NOT_FOUND` are absent by
 * design: each of the four carries information about a record, and a record an anonymous caller
 * can probe is an account directory with extra steps.
 */
const TRANSPORT_CODES: readonly ErrorCode[] = [
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "DEPENDENCY_FAILED",
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
  "INTERNAL_ERROR",
];

/** Codes no anonymous surface may ever answer, whatever else it says. */
export const FORBIDDEN_ON_ANONYMOUS_SURFACES: readonly ErrorCode[] = deepFreeze([
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "PERMISSION_DENIED",
  "RESOURCE_NOT_FOUND",
  "UNSUPPORTED_MEDIA_TYPE",
]);

/** Every anonymous surface, with the reason its code list ends where it does. */
export const ANONYMOUS_AUTH_SURFACES: readonly AnonymousSurface[] = deepFreeze([
  {
    path: "/api/auth/signin",
    codes: [...TRANSPORT_CODES, "VALIDATION_FAILED", "AUTHENTICATION_REQUIRED", "ACCOUNT_LOCKED"],
    note: "One refusal for a wrong password, an unknown address and an unconfirmed mail. The lock answer exists only after a correct password (section 22 line 238).",
  },
  {
    path: "/api/auth/signup",
    codes: [...TRANSPORT_CODES, "VALIDATION_FAILED"],
    note: "A form problem is a 422 with field details; an address that already exists is a 201 with the acceptance body, never a conflict.",
  },
  {
    path: "/api/auth/verify",
    codes: [...TRANSPORT_CODES, "VALIDATION_FAILED", "AUTHENTICATION_REQUIRED"],
    note: "A followed link either becomes a session or is refused with the same sentence an expired link has always produced.",
  },
  {
    path: "/api/auth/2fa/reset",
    codes: [...TRANSPORT_CODES, "VALIDATION_FAILED"],
    note: "Anonymous by necessity: the person who lost their second factor cannot sign in. One accepted answer, whatever the platform found.",
  },
]);

/** Surfaces that answer only to a signed-in merchant, listed so none is forgotten. */
export const SESSION_AUTH_SURFACES: readonly SessionSurface[] = deepFreeze([
  {
    path: "/api/auth/session/rotate",
    note: "The signed-in browser binds its session to a device key, or replaces a session token that is due for rotation. The answer names no account and hands back nothing but a token for the cookie that asked.",
  },
  {
    path: "/api/auth/devices",
    note: "The signed-in merchant registers the public half of this browser's proof key. The answer names a device of the caller's own account and is never reachable without a session.",
  },
  {
    path: "/api/auth/session/reauth",
    note: "Section 22's step-up: the signed-in person proves their second factor again so a stale session can perform a sensitive action (STEP 053). The answer carries a window, never an account.",
  },
  {
    path: "/api/auth/devices/confirm",
    note: "Section 22: the merchant confirms the device this session is bound to with their authenticator code (STEP 052). The answer names a device of the caller's own account and never a person.",
  },
  {
    path: "/api/auth/2fa/enroll",
    note: "The merchant starts the enrolment of their own second factor.",
  },
  {
    path: "/api/auth/2fa/confirm",
    note: "The merchant confirms the code of the enrolment they started.",
  },
  {
    path: "/api/auth/2fa/verify",
    note: "The second step of a sign in that already proved the password, or a step-up for a signed-in merchant.",
  },
  {
    path: "/api/auth/2fa/backup-codes",
    note: "The merchant mints or spends backup codes of their own account.",
  },
]);

/** What signup answers for an address that is new, and for one that is not. One shape, one body. */
export interface SignupAcceptance {
  readonly status: "verification_required";
}

export const SIGNUP_ACCEPTANCE: SignupAcceptance = deepFreeze({ status: "verification_required" });

/** What a 2FA reset request answers, for an account that exists and for one that does not. */
export interface TwoFactorResetAcceptance {
  readonly status: "accepted";
}

export const TWO_FACTOR_RESET_ACCEPTANCE: TwoFactorResetAcceptance = deepFreeze({ status: "accepted" });

/**
 * Detail rules that describe an account rather than a form.
 *
 * A validation detail is `{ field, rule }` - it names the input and what was wrong with it. That
 * is useful: "the password is too short" is a sentence the merchant can act on. "The email is
 * already registered" is a sentence only an attacker can act on, so a rule whose name says a
 * record exists, is missing, is locked or is enrolled is refused on an anonymous answer.
 */
const DISCLOSING_DETAIL_PATTERNS: readonly RegExp[] = deepFreeze([
  /exist/iu,
  /taken/iu,
  /duplicate/iu,
  /registered/iu,
  /already/iu,
  /not[_-]?found/iu,
  /unknown/iu,
  /missing/iu,
  /locked/iu,
  /unlocked/iu,
  /enrolled/iu,
  /enabled/iu,
  /disabled/iu,
  /unverified/iu,
  /unconfirmed/iu,
  /expired/iu,
  /revoked/iu,
]);

/** True when a detail rule would tell a stranger something about an account. */
export function isDisclosingDetail(rule: string): boolean {
  return DISCLOSING_DETAIL_PATTERNS.some((pattern) => pattern.test(rule));
}

/** The codes one surface may answer with, or `null` when the path is not an anonymous surface. */
export function anonymousSurfaceCodes(path: string): readonly ErrorCode[] | null {
  return ANONYMOUS_AUTH_SURFACES.find((surface) => surface.path === path)?.codes ?? null;
}

/** Every path this module classifies, anonymous or session-scoped. */
export function classifiedPaths(): readonly string[] {
  return [...ANONYMOUS_AUTH_SURFACES.map((surface) => surface.path), ...SESSION_AUTH_SURFACES.map((surface) => surface.path)];
}

/**
 * The refusal an anonymous surface sends.
 *
 * A fresh instance every time: an `AppError` carries details and a cause, and a shared instance
 * would let one route's detail appear in another route's answer. The catalog sentence is what a
 * client reads, and it is the same sentence for every reason the platform has.
 */
export function anonymousRejection(): AppError {
  return new AppError(ANONYMOUS_REFUSAL);
}

/** True when the code is in the catalog and the surface is allowed to answer it. */
export function isAllowedOnSurface(path: string, code: ErrorCode): boolean {
  return anonymousSurfaceCodes(path)?.includes(code) ?? false;
}

/** A code the catalog knows, used by the gate to catch a typo in this file. */
export function isCatalogCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code);
}
