// path: lib/security/csrf.ts
import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors/app-error.ts";

/**
 * Cross site request forgery, answered with the double submit token.
 *
 * ## Why a second token when the session cookie is already `SameSite=Strict`
 *
 * Because the two defences fail in different places, and rule 11 does not say "one of them". A cookie
 * attribute is the browser's promise: `SameSite=Strict` means a cross site form post does not carry
 * the session, and every browser the platform supports keeps that promise. The double submit does not
 * rely on the promise at all: the request must carry a value that a cross origin page cannot read -
 * `document.cookie` on `another.example` sees only its own cookies - so a page that *does* manage to
 * send the session still cannot guess the token. One defence is a policy, the other is a secret.
 *
 * ## The shape
 *
 * A random 32 bytes, base64url, in a readable cookie and in a request header. The server compares the
 * two and nothing else: the token is not stored, so there is no table and no expiry to sweep. What
 * makes that safe is the cookie's own attributes:
 *
 *   - the `__Host-` prefix, which a browser only accepts with `Secure`, `Path=/` and **no** `Domain`,
 *     so a sibling subdomain cannot write it - the one forgery path a storage-free token would
 *     otherwise have;
 *   - `HttpOnly` **absent** on purpose: the token exists to be read by the page's own script, and a
 *     token a script cannot read cannot be put in a header. It is a token for requests, not for
 *     identity, and it grants nothing on its own;
 *   - `SameSite=Strict`, `Path=/`, and a bounded `Max-Age`.
 *
 * ## The refusal
 *
 * `422 VALIDATION_FAILED` with `{ field: "csrf", rule: "csrf_token_invalid" }`. It is deliberately the
 * same answer for a missing cookie, a missing header, a malformed value and a mismatch: a caller who
 * is not the page learns nothing about which half failed. It is also deliberately **not**
 * `PERMISSION_DENIED`: the sign in and sign up surfaces must be able to answer it, and the disclosure
 * table of STEP 039 forbids that code on an anonymous surface - a CSRF failure on a stranger's form is
 * a form problem, not a statement about a record.
 */

/** The cookie name in a secure environment, with the prefix that makes the browser enforce its law. */
export const CSRF_COOKIE_NAME = "__Host-kd_csrf";

/** The cookie name outside a secure environment, where `__Host-` is refused over plain http. */
export const CSRF_COOKIE_NAME_INSECURE = "kd_csrf";

/** The header the page puts the same value in. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/** 32 bytes of randomness, base64url, which is 43 characters with no padding. */
export const CSRF_TOKEN_BYTES = 32;

/** The one length and alphabet every token has. */
export const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** How long a token lives. Long enough to survive a working day, short enough to be a cookie. */
export const CSRF_COOKIE_MAX_AGE_SECONDS = 43_200;

/** The field and rule a form shows, and the audit entry names. */
export const CSRF_FIELD = "csrf";
export const CSRF_RULE = "csrf_token_invalid";

/** The path the page asks for a token, which is the one auth route that has no session. */
export const CSRF_TOKEN_PATH = "/api/auth/csrf";

/** The routes that change something and are called by a browser. */
export const CSRF_PROTECTED_PATHS: readonly string[] = Object.freeze([
  "/api/auth/signin",
  "/api/auth/signup",
  "/api/auth/2fa/reset",
  "/api/auth/2fa/enroll",
  "/api/auth/2fa/confirm",
  "/api/auth/2fa/verify",
  "/api/auth/2fa/backup-codes",
  "/api/auth/devices",
  "/api/auth/devices/confirm",
  "/api/auth/session/rotate",
  "/api/auth/session/reauth",
  "/api/auth/sessions/revoke",
  "/api/office/2fa-reset-requests/decision",
  "/api/office/account-locks/unlock",
  "/api/office/announcements",
  "/api/office/approvals",
  "/api/office/compliance-calendar",
  "/api/office/countries",
  "/api/office/delegations",
  "/api/office/gateways",
  "/api/office/sessions/revoke",
  "/api/office/settings",
  "/api/onboarding/progress",
  "/api/onboarding/business-profile",
  "/api/onboarding/merchant-category",
  "/api/onboarding/business-address",
  "/api/onboarding/kyc-document",
  "/api/onboarding/kyc-ubo",
  "/api/onboarding/kyc-screening",
  "/api/onboarding/kyc-submit",
  "/api/onboarding/kyc-review-open",
  "/api/onboarding/kyc-document-review",
  "/api/onboarding/kyc-risk-mark",
  "/api/onboarding/kyc-decide",
  "/api/onboarding/underwriting-criteria",
  "/api/onboarding/underwriting-risk-tier",
  "/api/onboarding/underwriting-mcc-tier",
  "/api/onboarding/merchant-limit-set",
  "/api/onboarding/payment-hold-decide",
  "/api/onboarding/account-suspend",
  "/api/onboarding/account-reactivate-request",
  "/api/onboarding/account-reactivate-decide",
  "/api/onboarding/account-close-request",
  "/api/onboarding/account-close",
  "/api/clients",
  "/api/clients/[id]",
  "/api/clients/import",
  "/api/products",
  "/api/products/[id]",
  "/api/products/import",
  "/api/services",
  "/api/services/[id]",
  "/api/services/import",
  "/api/invoices",
  "/api/invoices/[id]/lines",
  "/api/invoices/[id]/lines/[lineId]",
  "/api/invoices/[id]/lines/[lineId]/move",
  "/api/invoices/[id]/discount",
  "/api/invoices/[id]/pdf",
  "/api/invoices/branding",
  "/api/invoices/branding/logo",
  "/api/invoices/numbering",
]);

/** Why a request was refused, for the log and the gate - never for the response. */
export type CsrfRejectionReason = "missing_cookie" | "missing_header" | "malformed_token" | "mismatch";

export interface CsrfDecision {
  readonly ok: boolean;
  readonly reason?: CsrfRejectionReason;
  /** The token that matched, so a caller can rotate it after a sign in if a later STEP wants to. */
  readonly token?: string;
}

export interface CsrfPolicy {
  readonly cookieName: string;
  readonly headerName: string;
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

/** The policy of one environment: the prefixed name whenever the transport is secure. */
export function csrfPolicy(options: { readonly secure?: boolean } = {}): CsrfPolicy {
  const secure = options.secure ?? true;

  return {
    cookieName: secure ? CSRF_COOKIE_NAME : CSRF_COOKIE_NAME_INSECURE,
    headerName: CSRF_HEADER_NAME,
    secure,
    maxAgeSeconds: CSRF_COOKIE_MAX_AGE_SECONDS,
  };
}

/** A new token. Random, not derived: a derived token would be a function of something the page knows. */
export function createCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
}

/** The `Set-Cookie` value that installs a token. */
export function csrfCookie(token: string, policy: CsrfPolicy = csrfPolicy()): string {
  if (!CSRF_TOKEN_PATTERN.test(token)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return [
    `${policy.cookieName}=${token}`,
    "Path=/",
    `Max-Age=${policy.maxAgeSeconds}`,
    "SameSite=Strict",
    ...(policy.secure ? ["Secure"] : []),
  ].join("; ");
}

/** The token of one cookie header, or null. A parser of one name, because one name is what exists. */
export function readCsrfCookie(cookieHeader: string | null, policy: CsrfPolicy = csrfPolicy()): string | null {
  if (cookieHeader === null || cookieHeader.trim().length === 0) {
    return null;
  }

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    if (pair.slice(0, separator).trim() !== policy.cookieName) {
      continue;
    }

    const value = pair.slice(separator + 1).trim();

    return CSRF_TOKEN_PATTERN.test(value) ? value : null;
  }

  return null;
}

/**
 * The comparison.
 *
 * `timingSafeEqual` over the bytes of two values of the same length, and a length check that answers
 * `false` before it is called - the length is not a secret (a token is always 43 characters), and a
 * comparison that returned early on a partial match would be the one measurable thing in this file.
 */
export function csrfTokensMatch(candidate: string, expected: string): boolean {
  if (!CSRF_TOKEN_PATTERN.test(candidate) || !CSRF_TOKEN_PATTERN.test(expected)) {
    return false;
  }

  if (candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(expected, "utf8"));
}

/** The decision, without throwing, so a route can log the reason while it answers one sentence. */
export function verifyCsrfRequest(
  request: Request,
  options: { readonly secure?: boolean } = {},
): CsrfDecision {
  const policy = csrfPolicy(options);
  const cookieToken = readCsrfCookie(request.headers.get("cookie"), policy);

  if (cookieToken === null) {
    return { ok: false, reason: "missing_cookie" };
  }

  const headerToken = request.headers.get(policy.headerName);

  if (headerToken === null) {
    return { ok: false, reason: "missing_header" };
  }

  if (!CSRF_TOKEN_PATTERN.test(headerToken)) {
    return { ok: false, reason: "malformed_token" };
  }

  if (!csrfTokensMatch(headerToken, cookieToken)) {
    return { ok: false, reason: "mismatch" };
  }

  return { ok: true, token: cookieToken };
}

/** The refusal, built fresh each time so no caller can mutate a shared instance. */
export function csrfRejection(): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field: CSRF_FIELD, rule: CSRF_RULE }] });
}

/**
 * The one call a route makes.
 *
 * It reads the request's headers and nothing else: no body, no session, no database, which is why it
 * belongs before the body is read and before the session is looked up - a forged request should cost
 * a string comparison, not a session lookup.
 */
export function requireCsrfToken(
  request: Request,
  options: { readonly secure?: boolean } = {},
): string {
  const decision = verifyCsrfRequest(request, options);

  if (!decision.ok || decision.token === undefined) {
    throw csrfRejection();
  }

  return decision.token;
}
